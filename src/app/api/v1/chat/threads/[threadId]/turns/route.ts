import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { enrichLogContext } from "@/lib/observability/context";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { buildToolSet } from "@/lib/agents/tools";
import { runNativeAgent, uiMessagesToPi } from "@/lib/agents/native";
import { createNativeUiStreamBridge } from "@/lib/agents/ui-stream";
import {
  AttachmentMessageError,
  hydrateWorkspaceAttachmentMessages,
} from "@/lib/attachments/messages";
import {
  parseChatAssistantModelParameters,
  parseChatTurn,
} from "@/lib/chat/schemas";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { HermesUIMessage } from "@/lib/agents/hermes/message-segments";
import {
  ChatServiceError,
  beginChatTurn,
  completeChatTurn,
  finishChatTurn,
  getChatHistoryForExecution,
  getChatThreadForExecution,
} from "@/lib/chat/service";
import { isWebSearchDeployment } from "@/lib/chat/web-search";
import { buildKeylessWebSearchToolSet } from "@/lib/chat/keyless-web-search";
import {
  startChatRun,
  cancelChatRun,
  isChatRunActive,
  type ChatRunOutput,
} from "@/lib/chat/run-control";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/turns",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    const input = parseChatTurn(raw);
    if (!input)
      return Response.json({ error: "Invalid chat turn" }, { status: 400 });

    const { threadId } = await params;
    const thread = await getChatThreadForExecution(user.id, threadId);
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    enrichLogContext({
      workspaceId: thread.workspaceId,
      conversationId: threadId,
    });
    const { assistant } = thread;
    const provider = assistant.modelProvider;
    if (!provider || !assistant.model) {
      return Response.json(
        { error: "This chat assistant has no model configured" },
        { status: 400 },
      );
    }
    assertRuntimeOwner();
    if (isChatRunActive(threadId))
      return Response.json(
        { error: "A chat turn is already running" },
        { status: 409 },
      );

    const last = input.messages.at(-1);
    if (!last)
      return Response.json({ error: "Invalid chat turn" }, { status: 400 });
    const targetMessageId =
      input.trigger === "regenerate-message"
        ? (input.messageId ?? thread.branch.activeMessageId ?? undefined)
        : input.messageId;
    const targetModelId = targetMessageId
      ? thread.branch.nodes.find((message) => message.id === targetMessageId)
          ?.modelId
      : null;
    const modelId =
      input.trigger === "regenerate-message" && targetModelId
        ? targetModelId
        : assistant.model;
    let turn: Awaited<ReturnType<typeof beginChatTurn>>;
    try {
      turn = await beginChatTurn(
        threadId,
        last.parts as unknown as Array<Record<string, unknown>>,
        { workspaceId: thread.workspaceId, userId: user.id },
        {
          trigger: input.trigger,
          messageId: targetMessageId,
          clientLastMessageId: last.id,
          modelId,
          expectedAssistantId: assistant.id,
        },
      );
    } catch (error) {
      if (error instanceof AttachmentMessageError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json({ error: "Chat request failed" }, { status: 500 });
    }

    let executionError: unknown;
    let succeeded = false;
    let output: ChatRunOutput;
    try {
      output = startChatRun(
        {
          threadId,
          turnId: turn.id,
          assistantMessageId: turn.assistantMessageId,
          workspaceId: thread.workspaceId,
          userId: user.id,
        },
        (signal) =>
          createUIMessageStream<HermesUIMessage>({
            generateId: () => turn.assistantMessageId,
            execute: async ({ writer }) => {
              writer.write({
                type: "start",
                messageId: turn.assistantMessageId,
              });
              const uiStream = createNativeUiStreamBridge(
                writer,
                `chat-${turn.id}`,
              );
              const contextUsage: { current: ContextUsageSnapshot | null } = {
                current: null,
              };
              try {
                const webDeploymentIds = assistant.mcpGrants
                  .filter((grant) => isWebSearchDeployment(grant.deployment))
                  .map((grant) => grant.deploymentId);
                const webDeploymentIdSet = new Set(webDeploymentIds);
                const regularDeploymentIds = assistant.mcpGrants
                  .map((grant) => grant.deploymentId)
                  .filter((id) => !webDeploymentIdSet.has(id));
                const [regularTools, webTools] = await Promise.all([
                  buildToolSet(regularDeploymentIds, thread.workspaceId),
                  input.webSearchEnabled
                    ? buildToolSet(webDeploymentIds, thread.workspaceId)
                    : Promise.resolve({}),
                ]);
                const tools = {
                  ...regularTools,
                  ...webTools,
                  ...(input.webSearchEnabled
                    ? buildKeylessWebSearchToolSet(signal)
                    : {}),
                };
                const persistedHistory = await getChatHistoryForExecution(
                  user.id,
                  threadId,
                  turn.historyLeafId,
                );
                const history = persistedHistory.map((message) => ({
                  id: message.id,
                  role: message.role,
                  parts: message.parts,
                }));
                const hydratedHistory =
                  (await hydrateWorkspaceAttachmentMessages(
                    history as unknown as Array<{
                      role: string;
                      parts: Array<Record<string, unknown>>;
                    }>,
                    {
                      workspaceId: thread.workspaceId,
                      scope: { chatThreadId: threadId },
                    },
                  )) as UIMessage[];
                signal.throwIfAborted();
                await runNativeAgent({
                  provider,
                  modelId,
                  systemPrompt: assistant.systemPrompt ?? "",
                  messages: uiMessagesToPi(hydratedHistory),
                  tools,
                  maxSteps: assistant.maxSteps,
                  modelParameters: parseChatAssistantModelParameters(
                    assistant.modelParameters,
                  ),
                  reasoningEffort: input.reasoningEffort,
                  signal,
                  onEvent: uiStream.onEvent,
                  onToolResult: uiStream.onToolResult,
                  onContextUsage: (usage) => {
                    contextUsage.current = usage;
                  },
                });
                signal.throwIfAborted();
                uiStream.finish();
                const usage = contextUsage.current;
                if (usage) {
                  writer.write({
                    type: "message-metadata",
                    messageMetadata: {
                      usage: { totalTokens: usage.usedTokens },
                    },
                  });
                  writer.write({ type: "data-context-usage", data: usage });
                }
                succeeded = true;
                writer.write({ type: "finish" });
              } catch (error) {
                executionError = signal.aborted ? signal.reason : error;
                uiStream.finish();
                if (signal.aborted && signal.reason?.name === "AbortError") {
                  writer.write({ type: "abort" });
                } else {
                  throw executionError;
                }
              }
            },
            onError: (error) =>
              error instanceof Error ? error.message : "Chat turn failed",
            onFinish: async ({ responseMessage, isAborted, outcome }) => {
              const parts = responseMessage.parts as unknown as Array<
                Record<string, unknown>
              >;
              if (
                !succeeded ||
                isAborted ||
                signal.aborted ||
                outcome.status === "failed"
              ) {
                const cancelled =
                  signal.aborted && signal.reason?.name === "AbortError";
                const error =
                  executionError ??
                  (outcome.status === "failed" ? outcome.error : undefined);
                await finishChatTurn(
                  threadId,
                  turn.id,
                  cancelled ? "cancelled" : "failed",
                  error instanceof Error ? error.message : "Chat turn failed",
                  turn.assistantMessageId,
                  parts,
                );
                return;
              }
              await completeChatTurn(
                threadId,
                turn.id,
                turn.assistantMessageId,
                parts,
              );
            },
          }),
      );
    } catch (error) {
      await finishChatTurn(
        threadId,
        turn.id,
        "failed",
        error instanceof Error ? error.message : "Chat start failed",
        turn.assistantMessageId,
      );
      throw error;
    }
    return workspaceAccessResponse(
      createUIMessageStreamResponse({
        stream: output.stream,
        headers: { "X-Chat-Turn-Id": output.turnId },
      }),
      thread.workspaceId,
      user.id,
      req.signal,
    );
  },
);

export const DELETE = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/turns",
  async function DELETE(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { threadId } = await params;
    const thread = await getChatThreadForExecution(user.id, threadId);
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    let input: unknown;
    try {
      input = await req.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("turnId" in input) ||
      typeof input.turnId !== "string" ||
      !input.turnId
    ) {
      return Response.json({ error: "A turn ID is required" }, { status: 400 });
    }
    // A delayed stop must never cancel a newer turn.
    return Response.json({ cancelled: cancelChatRun(threadId, input.turnId) });
  },
);
