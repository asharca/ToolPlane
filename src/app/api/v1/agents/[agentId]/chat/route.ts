import type { UIMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  runNativeEntry,
  latestEntryText,
  nativeEntryResult,
  nativeEntryRuntimeParts,
} from "@/lib/a2a/ingress";
import { parseAgentChatBody } from "@/lib/agents/chat-body";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { waitForConversationOperation } from "@/lib/agents/conversation-operations";
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
import { getAgentForRequest } from "@/lib/agents/queries";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { createSandboxUiStreamBridge } from "@/lib/agents/ui-stream";
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
    if (!body) return new Response("Bad request", { status: 400 });
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
    } catch (error) {
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
            const result = await runNativeEntry({
              kind: "chat",
              sourceId: conversation.id,
              workspaceId: liveAgent.workspaceId,
              agentId,
              actorId: user.id,
              messageId: userMessageId,
              text,
              signal: req.signal,
              onPromptInvocation: (invocation) =>
                persistAgentPromptInvocation({
                  conversationId: conversation.id,
                  messageId: savedUser.id,
                  invocation,
                }),
              onAccepted: (_task, path) =>
                uiStream.onTextDelta(
                  `Native task accepted. Tool approvals and progress: ${path}\n\n`,
                ),
            });
            const responseText = nativeEntryResult(result.task, result.path);
            const runtimeParts = nativeEntryRuntimeParts(result.task);
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "assistant",
                parts: [
                  { type: "text", text: responseText, state: "done" },
                  ...runtimeParts,
                ],
              },
            });
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
