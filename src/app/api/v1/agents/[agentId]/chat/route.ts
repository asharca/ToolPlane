import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import type { UIMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { persistSettledChatReply } from "@/lib/agents/execution/chat-reply";
import {
  parseRuntimeFailure,
  runtimeFailureText,
  taskRuntimeFailure,
} from "@/lib/agents/runtime-failure";
import { TaskState } from "@a2a-js/sdk";
import { runAgentEntry, latestEntryText } from "@/lib/agents/execution/entries";
import { parseAgentChatBody } from "@/lib/agents/chat-body";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { waitForConversationOperation } from "@/lib/agents/conversation-operations";
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
    const scope = await resolveWorkspaceScope(
      { id: liveAgent.workspaceId },
      user.id,
    );
    if (!scope) return new Response("Agent not found", { status: 404 });
    const conversation = await db.conversation.findFirst({
      where: {
        id: body.conversationId,
        agentId,
        agent: { workspace: workspaceScopeWhere(scope) },
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
      return new Response("The pinned Agent revision is unavailable.", {
        status: 409,
      });
    }
    const last = body.messages.at(-1);
    let text: string;
    try {
      text = latestEntryText(last);
    } catch {
      return new Response(
        "A nonempty user text message within the input limit is required.",
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
            agent: { workspace: workspaceScopeWhere(scope) },
          },
          data: {
            reasoningEffort:
              body.reasoningEffort === "default" ? null : body.reasoningEffort,
          },
        });
        if (updated.count !== 1)
          return new Response("Conversation not found", { status: 404 });
      }
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
              chatTextParts: (last.parts as Array<{ text: string }>).map(
                (part) => part.text,
              ),
              signal: req.signal,
              modelOverride: body.modelOverride,
              onMessageQueue: uiStream.onMessageQueue,
            });
            const parts = await persistSettledChatReply(result.task.id, {
              workspaceId: scope.id,
              agentId,
              actorId: user.id,
              conversationId: conversation.id,
            });
            if (!parts) throw new TaskNotFoundError();
            for (const part of parts) {
              if (part.type === "text") uiStream.onTextDelta(part.text);
              else if (part.type === "file") {
                const { url, mediaType, providerMetadata } = part;
                writer.write({
                  type: "file",
                  url,
                  mediaType,
                  providerMetadata,
                });
              } else writer.write(part);
            }
            const state = result.task.status?.state;
            if (
              state !== TaskState.TASK_STATE_COMPLETED &&
              state !== TaskState.TASK_STATE_INPUT_REQUIRED
            )
              throw new Error(
                runtimeFailureText(
                  taskRuntimeFailure(result.task) ?? {
                    code: "PI_EXECUTION_FAILED",
                  },
                ),
              );
          } finally {
            uiStream.finish();
            releaseConversation();
          }
        },
        onError: (error) =>
          runtimeFailureText(
            (error instanceof Error && parseRuntimeFailure(error.message)) || {
              code: "PI_EXECUTION_FAILED",
            },
          ),
      });
      streamOwnsConversation = true;
      return workspaceAccessResponse(
        createUIMessageStreamResponse({ stream }),
        scope,
        req.signal,
      );
    } finally {
      if (!streamOwnsConversation) releaseConversation();
    }
  },
);
