import {
  runNativeEntry,
  latestEntryText,
  nativeEntryResult,
  nativeEntryRuntimeParts,
} from "@/lib/a2a/ingress";
import type { UIMessage } from "ai";
import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { enrichLogContext } from "@/lib/observability/context";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { appendMessage } from "@/lib/agents/mutations";
import { resolveAgentTools } from "@/lib/agents/resolve";
import { assembleSystemPrompt } from "@/lib/agents/system-prompt";
import { buildAgentToolSet } from "@/lib/agents/run";
import { uiMessagesToPi, runNativeAgent } from "@/lib/agents/native";
import {
  createNativeUiStreamBridge,
  createSandboxUiStreamBridge,
} from "@/lib/agents/ui-stream";
import { parseAgentChatBody, type AgentChatBody } from "@/lib/agents/chat-body";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import {
  implementedAgentRuntimeKind,
  isDedicatedSandboxRuntimeKind,
} from "@/lib/agents/runtime-kind";
import {
  activeConversationMessages,
  latestCompaction,
} from "@/lib/agents/conversation-context";
import {
  acquireConversationOperation,
  waitForConversationOperation,
} from "@/lib/agents/conversation-operations";
import {
  AttachmentMessageError,
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
  hydrateWorkspaceAttachmentMessages,
} from "@/lib/attachments/messages";

export const runtime = "nodejs";
export const maxDuration = 900;

export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/chat",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ agentId: string }> },
  ) {
    const { agentId } = await params;
    const user = await resolveRequestUser(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const agent = await getAgentForRequest(agentId, user.id);
    if (!agent) return new Response("Not found", { status: 404 });
    const runtimeKind = implementedAgentRuntimeKind(agent.runtimeKind);
    if (!runtimeKind)
      return new Response(
        `Agent runtime "${agent.runtimeKind}" is not available.`,
        { status: 409 },
      );
    if (!agent.provider || !agent.model) {
      return new Response(
        "This agent has no model configured. Open Settings and pick a provider + model.",
        { status: 400 },
      );
    }

    let releaseConversation: (() => void) | null = null;
    let streamOwnsConversation = false;

    try {
      let body: AgentChatBody;
      try {
        const raw = await req.json();
        if (raw && typeof raw === "object" && "workSessionId" in raw) {
          return new Response("Work sessions must use the Work API", {
            status: 400,
          });
        }
        const parsed = parseAgentChatBody(raw);
        if (!parsed) return new Response("Bad request", { status: 400 });
        body = parsed;
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const messages = (body.messages ?? []) as AgentUIMessage[];

      // Only persist to a conversation that belongs to THIS agent.
      const conversation = body.conversationId
        ? ((await db.conversation.findFirst({
            where: { id: body.conversationId, agentId },
            select: {
              id: true,
              title: true,
              reasoningEffort: true,
              publicApiConversation: { select: { id: true } },
              workSession: { select: { id: true } },
            },
          })) ?? null)
        : null;
      const conversationId = conversation?.id ?? null;
      if (body.conversationId && !conversationId) {
        return new Response("Conversation not found", { status: 404 });
      }
      if (conversation?.workSession) {
        return new Response("Work conversations must use the Work API", {
          status: 400,
        });
      }
      if (
        conversation?.publicApiConversation ||
        conversation?.title?.startsWith("msg:")
      ) {
        return new Response("This conversation is read-only in the console", {
          status: 400,
        });
      }
      if (conversationId) enrichLogContext({ conversationId });
      if (conversationId) {
        releaseConversation = isDedicatedSandboxRuntimeKind(runtimeKind)
          ? await waitForConversationOperation(conversationId, req.signal)
          : acquireConversationOperation(conversationId);
        if (!releaseConversation)
          return new Response("This conversation is busy.", { status: 409 });
      }
      const storedMessages = conversationId
        ? await db.message.findMany({
            where: { conversationId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : [];
      const compaction = latestCompaction(storedMessages);
      const lastInput = messages.at(-1);
      const modelMessages = compaction
        ? ([
            ...activeConversationMessages(storedMessages),
            ...(lastInput?.role === "user" ? [lastInput] : []),
          ] as AgentUIMessage[])
        : messages;
      const storedReasoningEffort =
        normalizeReasoningEffort(conversation?.reasoningEffort) ?? "default";
      const reasoningEffort = body.reasoningEffort ?? storedReasoningEffort;
      if (
        conversationId &&
        body.reasoningEffort &&
        body.reasoningEffort !== storedReasoningEffort
      ) {
        const updated = await db.conversation.updateMany({
          where: {
            id: conversationId,
            agentId,
            agent: { workspaceId: agent.workspaceId },
          },
          data: {
            reasoningEffort:
              reasoningEffort === "default" ? null : reasoningEffort,
          },
        });
        if (updated.count !== 1)
          return new Response("Conversation not found", { status: 404 });
      }

      const last = messages[messages.length - 1];

      const provider = agent.provider;
      const model = agent.model;
      if (!provider || !model) {
        return new Response("This agent has no model configured.", {
          status: 400,
        });
      }

      let attachmentIds: string[];
      let hasAttachments: boolean;
      try {
        attachmentIds = last
          ? attachmentIdsFromParts(
              last.parts as unknown as Array<Record<string, unknown>>,
            )
          : [];
        hasAttachments = modelMessages.some(
          (message) =>
            attachmentIdsFromParts(
              message.parts as unknown as Array<Record<string, unknown>>,
            ).length > 0,
        );
      } catch (error) {
        return error instanceof AttachmentMessageError
          ? new Response(error.message, { status: error.status })
          : new Response("Invalid attachments.", { status: 400 });
      }
      if (hasAttachments && !conversationId) {
        return new Response("Attachments require a saved conversation.", {
          status: 400,
        });
      }
      if (attachmentIds.length && last?.role !== "user") {
        return new Response(
          "Attachments must be sent in the current user message.",
          { status: 400 },
        );
      }

      let hydratedMessages = modelMessages;
      if (hasAttachments && conversationId) {
        try {
          await db.$transaction((tx) =>
            claimWorkspaceAttachments(tx, {
              ids: attachmentIds,
              workspaceId: agent.workspaceId,
              uploadedById: user.id,
              scope: { conversationId },
            }),
          );
          hydratedMessages = (await hydrateWorkspaceAttachmentMessages(
            modelMessages as unknown as Array<{
              role: string;
              parts: Array<Record<string, unknown>>;
            }>,
            {
              workspaceId: agent.workspaceId,
              scope: { conversationId },
            },
          )) as AgentUIMessage[];
        } catch (error) {
          return error instanceof AttachmentMessageError
            ? new Response(error.message, { status: error.status })
            : new Response("Attachment processing failed.", { status: 502 });
        }
      }

      const resolved = resolveAgentTools(agent);
      const sandboxRuntime = isDedicatedSandboxRuntimeKind(runtimeKind);
      const tools = sandboxRuntime
        ? null
        : await buildAgentToolSet(resolved, {
            workspaceId: agent.workspaceId,
            depth: 0,
            visited: new Set([agentId]),
          });
      const system = sandboxRuntime
        ? agent.systemPrompt
        : assembleSystemPrompt(
            agent.systemPrompt,
            resolved.skills,
            Boolean(resolved.knowledgeBases?.length),
          );
      let executionSucceeded = false;
      const stream = createUIMessageStream<UIMessage>({
        originalMessages: messages,
        execute: async ({ writer }) => {
          if (sandboxRuntime) {
            const uiStream = createSandboxUiStreamBridge(
              writer,
              `sandbox-${agent.id}`,
            );
            if (!conversationId || !last?.id)
              throw new Error(
                "Create a conversation before submitting a native A2A task.",
              );
            const result = await runNativeEntry({
              kind: "chat",
              sourceId: conversationId,
              workspaceId: agent.workspaceId,
              agentId: agent.id,
              actorId: user.id,
              messageId: last.id,
              text: latestEntryText(last),
              signal: req.signal,
              onAccepted: (_task, path) =>
                uiStream.onTextDelta(
                  `Native task accepted. Tool approvals and progress: ${path}\n\n`,
                ),
            });
            uiStream.onTextDelta(nativeEntryResult(result.task, result.path));
            for (const part of nativeEntryRuntimeParts(result.task))
              writer.write(part);
            uiStream.finish();
            executionSucceeded = true;
            return;
          }
          if (!tools) throw new Error("Native chat tools are unavailable.");
          const uiStream = createNativeUiStreamBridge(
            writer,
            `native-${agent.id}`,
          );
          await runNativeAgent({
            provider,
            modelId: model,
            systemPrompt: system ?? "",
            messages: uiMessagesToPi(hydratedMessages),
            tools,
            maxSteps: agent.maxSteps,
            reasoningEffort,
            signal: req.signal,
            onEvent: uiStream.onEvent,
            onToolResult: uiStream.onToolResult,
          });
          uiStream.finish();
          executionSucceeded = true;
        },
        onError: (error) => {
          return error instanceof Error
            ? error.message
            : "Agent request failed.";
        },
        onFinish: async ({ responseMessage, isAborted }) => {
          try {
            if (
              isAborted ||
              req.signal.aborted ||
              !executionSucceeded ||
              !conversationId
            )
              return;
            if (last?.role === "user") {
              await appendMessage(conversationId, "user", last.parts as never);
            }
            await appendMessage(
              conversationId,
              "assistant",
              responseMessage.parts as never,
            );
          } finally {
            releaseConversation?.();
          }
        },
      });
      streamOwnsConversation = true;
      return workspaceAccessResponse(
        createUIMessageStreamResponse({ stream }),
        agent.workspaceId,
        user.id,
        req.signal,
      );
    } finally {
      if (!streamOwnsConversation) releaseConversation?.();
    }
  },
);
