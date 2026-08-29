import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { buildToolSet } from '@/lib/agents/tools';
import { runNativeAgent, uiMessagesToPi } from '@/lib/agents/native';
import { createNativeUiStreamBridge } from '@/lib/agents/ui-stream';
import {
  AttachmentMessageError,
  hydrateWorkspaceAttachmentMessages,
} from '@/lib/attachments/messages';
import { parseChatTurn } from '@/lib/chat/schemas';
import type { ContextUsageSnapshot } from '@/lib/context-usage';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import {
  ChatServiceError,
  beginChatTurn,
  completeChatTurn,
  finishChatTurn,
  getChatHistoryForExecution,
  getChatThreadForExecution,
} from '@/lib/chat/service';
import { isWebSearchDeployment } from '@/lib/chat/web-search';
import { buildKeylessWebSearchToolSet } from '@/lib/chat/keyless-web-search';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  const input = parseChatTurn(raw);
  if (!input) return Response.json({ error: 'Invalid chat turn' }, { status: 400 });

  const { threadId } = await params;
  const thread = await getChatThreadForExecution(user.id, threadId);
  if (!thread) return Response.json({ error: 'Chat thread not found' }, { status: 404 });
  const { assistant } = thread;
  if (!assistant.modelProvider || !assistant.model) {
    return Response.json({ error: 'This chat assistant has no model configured' }, { status: 400 });
  }

  const last = input.messages.at(-1)!;
  const targetMessageId = input.trigger === 'regenerate-message'
    ? input.messageId ?? thread.branch.activeMessageId ?? undefined
    : input.messageId;
  const targetModelId = targetMessageId
    ? thread.branch.nodes.find((message) => message.id === targetMessageId)?.modelId
    : null;
  const modelId = input.trigger === 'regenerate-message' && targetModelId
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
      return Response.json({ error: error.message }, { status: error.status });
    }
    return error instanceof ChatServiceError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Chat request failed' }, { status: 500 });
  }

  const webDeploymentIds = assistant.mcpGrants
    .filter((grant) => isWebSearchDeployment(grant.deployment))
    .map((grant) => grant.deploymentId);
  const webDeploymentIdSet = new Set(webDeploymentIds);
  const regularDeploymentIds = assistant.mcpGrants
    .map((grant) => grant.deploymentId)
    .filter((deploymentId) => !webDeploymentIdSet.has(deploymentId));
  let tools: Awaited<ReturnType<typeof buildToolSet>>;
  try {
    const [regularTools, webTools] = await Promise.all([
      buildToolSet(regularDeploymentIds, thread.workspaceId),
      input.webSearchEnabled
        ? buildToolSet(webDeploymentIds, thread.workspaceId)
        : Promise.resolve({}),
    ]);
    tools = {
      ...regularTools,
      ...webTools,
      ...(input.webSearchEnabled ? buildKeylessWebSearchToolSet(req.signal) : {}),
    };
  } catch (error) {
    await finishChatTurn(threadId, turn.id, 'failed', error instanceof Error ? error.message : 'MCP discovery failed', turn.assistantMessageId);
    return Response.json({ error: 'MCP discovery failed' }, { status: 503 });
  }

  let history: UIMessage[];
  try {
    const persistedHistory = await getChatHistoryForExecution(user.id, threadId, turn.historyLeafId);
    history = persistedHistory.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts,
    })) as UIMessage[];
  } catch (error) {
    await finishChatTurn(threadId, turn.id, 'failed', error instanceof Error ? error.message : 'Chat history failed', turn.assistantMessageId);
    return Response.json({ error: 'Chat history failed' }, { status: 500 });
  }
  let hydratedHistory: UIMessage[];
  try {
    hydratedHistory = await hydrateWorkspaceAttachmentMessages(
      history as unknown as Array<{ role: string; parts: Array<Record<string, unknown>> }>,
      { workspaceId: thread.workspaceId, scope: { chatThreadId: threadId } },
    ) as UIMessage[];
  } catch (error) {
    await finishChatTurn(threadId, turn.id, 'failed', error instanceof Error ? error.message : 'Attachment hydration failed', turn.assistantMessageId);
    return error instanceof AttachmentMessageError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'Attachment hydration failed' }, { status: 502 });
  }

  const stream = createUIMessageStream<HermesUIMessage>({
    generateId: () => turn.assistantMessageId,
    originalMessages: input.messages as HermesUIMessage[],
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageId: turn.assistantMessageId });
      const uiStream = createNativeUiStreamBridge(writer, `chat-${turn.id}`);
      const contextUsage: { current: ContextUsageSnapshot | null } = { current: null };
      try {
        await runNativeAgent({
          provider: assistant.modelProvider!,
          modelId,
          systemPrompt: assistant.systemPrompt ?? '',
          messages: uiMessagesToPi(hydratedHistory),
          tools,
          maxSteps: assistant.maxSteps,
          signal: req.signal,
          onEvent: uiStream.onEvent,
          onToolResult: uiStream.onToolResult,
          onContextUsage: (usage) => { contextUsage.current = usage; },
        });
        uiStream.finish();
        const usage = contextUsage.current;
        if (usage) {
          writer.write({
            type: 'message-metadata',
            messageMetadata: { usage: { totalTokens: usage.usedTokens } },
          });
          writer.write({ type: 'data-context-usage', data: usage });
        }
      } catch (error) {
        if (req.signal.aborted) {
          await finishChatTurn(threadId, turn.id, 'cancelled', undefined, turn.assistantMessageId);
        } else {
          await finishChatTurn(threadId, turn.id, 'failed', error instanceof Error ? error.message : 'Chat turn failed', turn.assistantMessageId);
        }
        throw error;
      }
    },
    onError: (error) => error instanceof Error ? error.message : 'Chat turn failed',
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted || req.signal.aborted) {
        await finishChatTurn(threadId, turn.id, 'cancelled', undefined, turn.assistantMessageId);
        return;
      }
      await completeChatTurn(
        threadId,
        turn.id,
        turn.assistantMessageId,
        responseMessage.parts as unknown as Array<Record<string, unknown>>,
      );
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: { 'X-Chat-Turn-Id': turn.id },
  });
}
