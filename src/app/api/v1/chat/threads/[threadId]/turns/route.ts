import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { enrichLogContext } from "@/lib/observability/context";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { buildChatToolSet } from "@/lib/chat/tools";
import { wrapChatTools } from "@/lib/chat/durable-tools";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { runNativeAgent, uiMessagesToPi } from "@/lib/agents/native";
import { db } from "@/lib/db";
import { modelReasoningSupported } from "@/lib/agents/model";
import { DEFAULT_REASONING_LEVEL } from "@/lib/agents/constants";
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
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import {
  ChatServiceError,
  beginChatTurn,
  completeChatTurn,
  finishChatTurn,
  getChatHistoryForExecution,
  getChatThreadForExecution,
  getChatThreadForUser,
  getChatTurnReplay,
  type ChatTurnAdmission,
  resolveChatTurnModel,
} from "@/lib/chat/service";
import { buildKeylessWebSearchToolSet } from "@/lib/chat/keyless-web-search";
import {
  startChatRun,
  appendChatExecutionStage,
  cancelChatRun,
  recoverStaleChatRuns,
  subscribeChatRun,
  chatRunHeaders,
  type ChatRunOutput,
} from "@/lib/chat/run-control";
import type { ChatExecutionStage } from "@/lib/chat/execution-stage";
import {
  assertRuntimeOwner,
  RuntimeUnavailableError,
} from "@/lib/runtime/ownership-state";

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
    const last = input.messages.at(-1);
    if (!last)
      return Response.json({ error: "Invalid chat turn" }, { status: 400 });
    const requestHash = marketReleaseChecksum({
      message: last,
      trigger: input.trigger,
      messageId: input.messageId ?? null,
      webSearchEnabled: input.webSearchEnabled,
      reasoningEffort: input.reasoningEffort ?? null,
      modelOverride: input.modelOverride ?? null,
    });
    let thread: Awaited<ReturnType<typeof getChatThreadForExecution>>;
    try {
      await recoverStaleChatRuns(threadId);
      const replay = await getChatTurnReplay(
        user.id,
        threadId,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) {
        const output = await subscribeChatRun(threadId, null, {
          userId: user.id,
          workspaceId: replay.workspaceId,
          runId: replay.runId,
        });
        return output
          ? createUIMessageStreamResponse({
              stream: output.stream,
              headers: chatRunHeaders(output),
            })
          : new Response(null, { status: 204 });
      }
      thread = await getChatThreadForExecution(user.id, threadId);
    } catch (error) {
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json(
            { error: "Chat configuration is unavailable" },
            { status: 500 },
          );
    }
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    enrichLogContext({
      workspaceId: thread.workspaceId,
      conversationId: threadId,
    });
    const { assistant } = thread;
    let provider = assistant.modelProvider;
    let modelId = assistant.model;
    if (input.modelOverride) {
      try {
        const historyParts = [
          ...thread.messages.flatMap((message) =>
            Array.isArray(message.parts) ? message.parts : [],
          ),
          ...last.parts,
        ];
        const modalities = new Set<string>();
        for (const part of historyParts) {
          if (
            !part ||
            typeof part !== "object" ||
            !("mediaType" in part) ||
            typeof part.mediaType !== "string"
          )
            continue;
          const modality = part.mediaType.split("/")[0];
          if (
            modality === "image" ||
            modality === "audio" ||
            modality === "video"
          )
            modalities.add(modality);
        }
        ({ provider, modelId } = await resolveChatTurnModel(
          thread.workspaceId,
          input.modelOverride,
          {
            tools:
              input.webSearchEnabled ||
              assistant.mcpGrants.some(
                (grant) => grant.allowedToolNames.length > 0,
              ),
            reasoning: Boolean(
              input.reasoningEffort && input.reasoningEffort !== "default",
            ),
            modalities: [...modalities],
          },
        ));
      } catch (error) {
        return error instanceof ChatServiceError
          ? Response.json({ error: error.message }, { status: error.status })
          : Response.json(
              { error: "Chat configuration is unavailable" },
              { status: 500 },
            );
      }
    }
    if (!provider || !modelId) {
      return Response.json(
        { error: "This chat assistant has no model configured" },
        { status: 400 },
      );
    }
    const effectiveProvider = provider;
    const effectiveModel = modelId;
    const requestedReasoning =
      input.reasoningEffort && input.reasoningEffort !== "default"
        ? input.reasoningEffort
        : (assistant.reasoningEffort ?? DEFAULT_REASONING_LEVEL);
    const modelRecord = requestedReasoning
      ? await db.providerModel.findUnique({
          where: {
            providerId_modelId: {
              providerId: effectiveProvider.id,
              modelId: effectiveModel,
            },
          },
          select: { capabilities: true },
        })
      : null;
    const reasoningEffort =
      requestedReasoning &&
      modelReasoningSupported(effectiveProvider, effectiveModel, modelRecord)
        ? requestedReasoning
        : undefined;

    const targetMessageId =
      input.trigger === "regenerate-message"
        ? (input.messageId ?? thread.branch.activeMessageId ?? undefined)
        : input.messageId;
    let turn: ChatTurnAdmission;
    try {
      assertRuntimeOwner();
      turn = await beginChatTurn(
        threadId,
        last.parts as unknown as Array<Record<string, unknown>>,
        { workspaceId: thread.workspaceId, userId: user.id },
        {
          trigger: input.trigger,
          messageId: targetMessageId,
          clientLastMessageId: last.id,
          modelId,
          modelProviderId: provider.id,
          expectedAssistantId: assistant.id,
          expectedAssistantRevisionId: thread.assistantRevisionId ?? undefined,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      );
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        return Response.json(
          { error: "runtime_not_ready" },
          {
            status: 503,
            headers: { "Retry-After": "5", "cache-control": "no-store" },
          },
        );
      }
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
    enrichLogContext({ runId: turn.id });

    let executionError: unknown;
    let succeeded = false;
    let finalParts: Array<Record<string, unknown>> = [];
    let finalCancelled = false;
    let output: ChatRunOutput;
    const runScope = {
      threadId,
      turnId: turn.id,
      assistantMessageId: turn.assistantMessageId,
      workspaceId: thread.workspaceId,
      userId: user.id,
    };
    try {
      output = await startChatRun(
        runScope,
        (runSignal, fence) => {
          const unknownEffect = new AbortController();
          const signal = AbortSignal.any([runSignal, unknownEffect.signal]);
          let stage: ChatExecutionStage | undefined;
          const publishStage = async (next: ChatExecutionStage) => {
            if (stage === next) return;
            await appendChatExecutionStage(runScope, fence, next);
            stage = next;
          };
          return createUIMessageStream<AgentUIMessage>({
            generateId: () => turn.assistantMessageId,
            execute: async ({ writer }) => {
              writer.write({
                type: "start",
                messageId: turn.assistantMessageId,
              });
              writer.write({
                type: "data-model",
                data: {
                  providerId: effectiveProvider.id,
                  model: effectiveModel,
                },
              });
              const uiStream = createNativeUiStreamBridge(
                writer,
                `chat-${turn.id}`,
              );
              const contextUsage: { current: ContextUsageSnapshot | null } = {
                current: null,
              };
              try {
                await publishStage("preparing");
                // Drain both branches before finishing the turn, including on
                // failure: remote discovery may still own deployment lifecycle work.
                const [remoteToolsResult, historyResult] =
                  await Promise.allSettled([
                    buildChatToolSet({
                      assistantId: assistant.id,
                      workspaceId: thread.workspaceId,
                      userId: user.id,
                      config: thread.revisionConfig,
                      signal,
                    }),
                    (async () => {
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
                      return (await hydrateWorkspaceAttachmentMessages(
                        history as unknown as Array<{
                          role: string;
                          parts: Array<Record<string, unknown>>;
                        }>,
                        {
                          workspaceId: thread.workspaceId,
                          scope: { chatThreadId: threadId },
                        },
                      )) as UIMessage[];
                    })(),
                  ]);
                // Keep the original preparation error precedence, not completion order.
                if (remoteToolsResult.status === "rejected")
                  throw remoteToolsResult.reason;
                if (historyResult.status === "rejected")
                  throw historyResult.reason;
                const hydratedHistory = historyResult.value;
                const tools = wrapChatTools(
                  {
                    ...remoteToolsResult.value,
                    ...(input.webSearchEnabled
                      ? buildKeylessWebSearchToolSet(signal)
                      : {}),
                  },
                  {
                    threadId,
                    turnId: turn.id,
                    assistantMessageId: turn.assistantMessageId,
                    workspaceId: thread.workspaceId,
                    userId: user.id,
                    fence,
                    signal,
                    onUnknownOutcome: (error) => unknownEffect.abort(error),
                  },
                );
                signal.throwIfAborted();
                await runNativeAgent({
                  provider: effectiveProvider,
                  modelId: effectiveModel,
                  systemPrompt: assistant.systemPrompt ?? "",
                  messages: uiMessagesToPi(hydratedHistory),
                  tools,
                  maxSteps: assistant.maxSteps,
                  modelParameters: parseChatAssistantModelParameters(
                    assistant.modelParameters,
                  ),
                  reasoningEffort,
                  signal,
                  onModelRequest: () => publishStage("waiting-model"),
                  onEvent: async (event) => {
                    if (
                      ((event.type === "text_delta" ||
                        event.type === "thinking_delta" ||
                        event.type === "toolcall_delta") &&
                        event.delta.length > 0) ||
                      event.type === "toolcall_start" ||
                      event.type === "toolcall_end"
                    )
                      await publishStage("generating");
                    uiStream.onEvent(event);
                  },
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
              finalParts = responseMessage.parts as unknown as Array<
                Record<string, unknown>
              >;
              finalCancelled = Boolean(
                signal.aborted && signal.reason?.name === "AbortError",
              );
              if (
                !succeeded ||
                isAborted ||
                signal.aborted ||
                outcome.status === "failed"
              ) {
                succeeded = false;
                executionError ??=
                  outcome.status === "failed" ? outcome.error : signal.reason;
              }
            },
          });
        },
        async (fence) => {
          if (succeeded) {
            await completeChatTurn(
              threadId,
              turn.id,
              turn.assistantMessageId,
              finalParts,
              fence,
            );
            return { outcome: "success" as const };
          } else {
            await finishChatTurn(
              threadId,
              turn.id,
              finalCancelled ? "cancelled" : "failed",
              executionError instanceof Error
                ? executionError.message
                : "Chat turn failed",
              turn.assistantMessageId,
              finalParts,
              fence,
            );
            return {
              outcome: finalCancelled
                ? ("cancelled" as const)
                : ("error" as const),
              error: executionError,
            };
          }
        },
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
        headers: chatRunHeaders(output),
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
    const thread = await getChatThreadForUser(user.id, threadId);
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
    const requested = await cancelChatRun(threadId, input.turnId);
    return Response.json(
      { stopRequested: requested, turnId: input.turnId },
      { status: requested ? 202 : 200 },
    );
  },
);
