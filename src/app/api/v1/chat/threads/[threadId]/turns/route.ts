import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { buildToolSet } from '@/lib/agents/tools';
import { runNativeAgent, uiMessagesToPi } from '@/lib/agents/native';
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

  let tools: Awaited<ReturnType<typeof buildToolSet>>;
  try {
    tools = await buildToolSet(
      assistant.mcpGrants.map((grant) => grant.deploymentId),
      thread.workspaceId,
    );
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
      const textPartIds = new Map<number, string>();
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
          onEvent: (event) => {
            if (event.type === 'text_start') {
              const id = `chat-${turn.id}-${event.contentIndex}`;
              textPartIds.set(event.contentIndex, id);
              writer.write({ type: 'text-start', id });
            } else if (event.type === 'text_delta') {
              let id = textPartIds.get(event.contentIndex);
              if (!id) {
                id = `chat-${turn.id}-${event.contentIndex}`;
                textPartIds.set(event.contentIndex, id);
                writer.write({ type: 'text-start', id });
              }
              writer.write({ type: 'text-delta', id, delta: event.delta });
            } else if (event.type === 'text_end') {
              const id = textPartIds.get(event.contentIndex);
              if (id) writer.write({ type: 'text-end', id });
            } else if (event.type === 'toolcall_end') {
              writer.write({ type: 'tool-input-start', toolCallId: event.toolCall.id, toolName: event.toolCall.name });
              writer.write({
                type: 'tool-input-available',
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
                input: event.toolCall.arguments,
              });
            }
          },
          onToolResult: (toolCall, output, isError) => {
            if (isError) {
              writer.write({
                type: 'tool-output-error',
                toolCallId: toolCall.id,
                errorText: output instanceof Error ? output.message : JSON.stringify(output),
              });
            } else {
              writer.write({ type: 'tool-output-available', toolCallId: toolCall.id, output });
            }
          },
          onContextUsage: (usage) => { contextUsage.current = usage; },
        });
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
