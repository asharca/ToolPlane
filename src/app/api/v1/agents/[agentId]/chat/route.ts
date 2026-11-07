import type { UIMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { getTaskRow } from "@/lib/a2a/store";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { nativeUiView } from "@/lib/agents/execution/native-ui";
import {
  runAgentEntry,
  latestEntryText,
  agentEntryResult,
  agentEntryRuntimeParts,
} from "@/lib/agents/execution/entries";
import { parseAgentChatBody } from "@/lib/agents/chat-body";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { waitForConversationOperation } from "@/lib/agents/conversation-operations";
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
import { getAgentForRequest } from "@/lib/agents/queries";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { createSandboxUiStreamBridge } from "@/lib/agents/ui-stream";
import {
  AgentModelOverrideError,
  resolveAgentModelOverride,
} from "@/lib/agents/turn-model";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { enrichLogContext } from "@/lib/observability/context";
import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { notifyTaskOutput } from "@/lib/agents/execution/live-output";

export const runtime = "nodejs";
export const maxDuration = 900;

export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/chat",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ agentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const { agentId } = await params;
    const liveAgent = await getAgentForRequest(agentId, user.id);
    if (!liveAgent) return new Response("Not found", { status: 404 });
    if (liveAgent.runtimeKind !== "pi-sdk" || liveAgent.retiredAt)
      return new Response("Historical Agent sessions are read-only.", {
        status: 409,
      });

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (raw && typeof raw === "object" && "workSessionId" in raw)
      return new Response("Work sessions must use the Work API", {
        status: 400,
      });
    const body = parseAgentChatBody(raw);
    if (!body)
      return raw && typeof raw === "object" && "modelOverride" in raw
        ? Response.json({ error: "modelOverrideInvalid" }, { status: 400 })
        : new Response("Bad request", { status: 400 });
    if (!body.conversationId)
      return new Response(
        "Create a conversation before submitting a native task.",
        { status: 400 },
      );
    const conversation = await db.conversation.findFirst({
      where: {
        id: body.conversationId,
        agentId,
        agent: { workspaceId: liveAgent.workspaceId },
      },
      select: {
        id: true,
        title: true,
        agentRevisionId: true,
        legacyRevisionUnresolved: true,
        reasoningEffort: true,
        publicApiConversation: { select: { id: true } },
        workSession: { select: { id: true } },
      },
    });
    if (!conversation)
      return new Response("Conversation not found", { status: 404 });
    if (conversation.workSession)
      return new Response("Work conversations must use the Work API", {
        status: 400,
      });
    if (
      conversation.publicApiConversation ||
      conversation.title?.startsWith("msg:")
    )
      return new Response("This conversation is read-only in the console", {
        status: 400,
      });
    if (conversation.legacyRevisionUnresolved || !conversation.agentRevisionId)
      return new Response("Historical Agent sessions are read-only.", {
        status: 409,
      });
    try {
      await resolvePinnedAgent(liveAgent, conversation.agentRevisionId);
      if (body.modelOverride)
        await resolveAgentModelOverride(
          liveAgent.workspaceId,
          body.modelOverride,
          liveAgent.runtimeKind,
        );
    } catch (error) {
      if (error instanceof AgentModelOverrideError)
        return Response.json({ error: error.code }, { status: error.status });
      return new Response(
        error instanceof Error
          ? error.message
          : "The pinned Agent revision is unavailable.",
        { status: 409 },
      );
    }
    const last = body.messages.at(-1);
    let text: string;
    try {
      text = latestEntryText(last);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "A user message is required.",
        { status: 400 },
      );
    }
    if (!last?.id)
      return new Response("A user message is required.", { status: 400 });
    const userMessageId = last.id;
    enrichLogContext({ conversationId: conversation.id });
    const releaseConversation = await waitForConversationOperation(
      conversation.id,
      req.signal,
    );
    let streamOwnsConversation = false;
    try {
      const storedReasoning =
        normalizeReasoningEffort(conversation.reasoningEffort) ?? "default";
      if (body.reasoningEffort && body.reasoningEffort !== storedReasoning) {
        const updated = await db.conversation.updateMany({
          where: {
            id: conversation.id,
            agentId,
            agentRevisionId: conversation.agentRevisionId,
            agent: { workspaceId: liveAgent.workspaceId },
          },
          data: {
            reasoningEffort:
              body.reasoningEffort === "default" ? null : body.reasoningEffort,
          },
        });
        if (updated.count !== 1)
          return new Response("Conversation not found", { status: 404 });
      }
      // The authored text is persisted before execution: trusted Prompt expansion
      // metadata must survive provider errors, cancellation, and failed tools.
      const userParts = (
        last.parts as Array<{ type: "text"; text: string }>
      ).map((part) => ({ type: "text", text: part.text }));
      const savedUser = await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          parts: userParts,
        },
      });
      const stream = createUIMessageStream<UIMessage>({
        originalMessages: body.messages,
        execute: async ({ writer }) => {
          const uiStream = createSandboxUiStreamBridge(
            writer,
            `sandbox-${agentId}`,
          );
          try {
            const result = await runAgentEntry({
              kind: "chat",
              sourceId: conversation.id,
              workspaceId: liveAgent.workspaceId,
              agentId,
              actorId: user.id,
              messageId: userMessageId,
              text,
              signal: req.signal,
              modelOverride: body.modelOverride,
              onPromptInvocation: (invocation) =>
                persistAgentPromptInvocation({
                  conversationId: conversation.id,
                  messageId: savedUser.id,
                  invocation,
                }),
            });
            const binding = await db.a2AEntryBinding.findFirst({
              where: {
                kind: "chat",
                sourceId: conversation.id,
                lastTaskId: result.task.id,
                context: {
                  workspaceId: liveAgent.workspaceId,
                  agentId,
                  targetKind: "local",
                },
              },
              select: { lastTask: { select: { grant: true } } },
            });
            const grant = binding?.lastTask.grant as unknown as TaskGrant;
            if (
              !binding ||
              !isLocalGrant(grant) ||
              grant.workspaceId !== liveAgent.workspaceId ||
              grant.agentId !== agentId ||
              grant.actorId !== user.id ||
              grant.entryPolicy?.kind !== "chat" ||
              grant.entryPolicy.sourceId !== conversation.id ||
              grant.entryPolicy.sourceAgentId !== agentId
            )
              throw new TaskNotFoundError();
            const task = await getTaskRow(grant, result.task.id);
            if (task.parentTaskId || task.rootTaskId !== task.id)
              throw new TaskNotFoundError();
            const projection = nativeUiView(task.uiProjection);
            const hookParts = projection.hooks.map((hook) => ({
              type: "data-hook-activity" as const,
              id: `native-hook:${hook.id}`,
              data: hook,
            }));
            const childParts = projection.activities.map((activity) => ({
              type: "data-subagent-activity" as const,
              id: `native-child:${task.id}:${JSON.stringify([activity.type, activity.source.subagentId, activity.toolCallId ?? null])}`,
              data: activity,
            }));
            let responseText = "";
            let responseFailed = false;
            let responseError: unknown;
            try {
              responseText = agentEntryResult(result.task, result.path);
            } catch (error) {
              responseFailed = true;
              responseError = error;
            }
            const runtimeParts = agentEntryRuntimeParts(result.task);
            const parts = [
              ...runtimeParts,
              ...hookParts,
              ...childParts,
              ...(responseFailed
                ? []
                : [{ type: "text", text: responseText, state: "done" }]),
            ];
            if (parts.length)
              await db.message.create({
                data: {
                  conversationId: conversation.id,
                  role: "assistant",
                  parts,
                },
              });
            notifyTaskOutput(result.task.id);
            for (const part of hookParts) writer.write(part);
            for (const part of childParts) writer.write(part);
            if (responseFailed) throw responseError;
            uiStream.onTextDelta(responseText);
            for (const part of runtimeParts) writer.write(part);
          } finally {
            uiStream.finish();
            releaseConversation();
          }
        },
        onError: (error) =>
          error instanceof Error ? error.message : "Agent request failed.",
      });
      streamOwnsConversation = true;
      return workspaceAccessResponse(
        createUIMessageStreamResponse({ stream }),
        liveAgent.workspaceId,
        user.id,
        req.signal,
      );
    } finally {
      if (!streamOwnsConversation) releaseConversation();
    }
  },
);
