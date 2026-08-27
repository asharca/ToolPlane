// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  buildTools: vi.fn(),
  complete: vi.fn(),
  createResponse: vi.fn(),
  createStream: vi.fn(),
  finish: vi.fn(),
  getHistory: vi.fn(),
  getThread: vi.fn(),
  hydrate: vi.fn(),
  resolveUser: vi.fn(),
  runNative: vi.fn(),
}));

vi.mock('ai', () => ({
  createUIMessageStream: mocks.createStream,
  createUIMessageStreamResponse: mocks.createResponse,
}));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveUser }));
vi.mock('@/lib/agents/tools', () => ({ buildToolSet: mocks.buildTools }));
vi.mock('@/lib/agents/native', () => ({ runNativeAgent: mocks.runNative, uiMessagesToPi: vi.fn(() => []) }));
vi.mock('@/lib/attachments/messages', () => ({
  AttachmentMessageError: class AttachmentMessageError extends Error {},
  hydrateWorkspaceAttachmentMessages: mocks.hydrate,
}));
vi.mock('@/lib/chat/service', () => ({
  ChatServiceError: class ChatServiceError extends Error {},
  beginChatTurn: mocks.begin,
  completeChatTurn: mocks.complete,
  finishChatTurn: mocks.finish,
  getChatHistoryForExecution: mocks.getHistory,
  getChatThreadForExecution: mocks.getThread,
}));

import { POST } from '@/app/api/v1/chat/threads/[threadId]/turns/route';

function request(signal?: AbortSignal) {
  return new Request('http://toolplane.test/api/v1/chat/threads/thread-1/turns', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Retry' }] }],
      trigger: 'regenerate-message',
      messageId: 'assistant-old',
    }),
  });
}

describe('chat turn stream contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUser.mockResolvedValue({ id: 'user-1' });
    mocks.getThread.mockResolvedValue({
      workspaceId: 'workspace-1',
      branch: {
        activeMessageId: 'assistant-old',
        nodes: [{ id: 'assistant-old', modelId: 'historic-model' }],
      },
      assistant: {
        modelProvider: { id: 'provider-1' },
        model: 'current-model',
        mcpGrants: [],
        systemPrompt: null,
        maxSteps: 5,
      },
    });
    mocks.begin.mockResolvedValue({
      id: 'turn-1',
      assistantMessageId: 'assistant-stable',
      historyLeafId: 'user-1',
    });
    mocks.buildTools.mockResolvedValue({});
    mocks.getHistory.mockResolvedValue([]);
    mocks.hydrate.mockResolvedValue([]);
    mocks.runNative.mockResolvedValue(undefined);
    mocks.createStream.mockImplementation((config) => config);
    mocks.createResponse.mockImplementation(({ headers }) => new Response(null, { headers }));
  });

  it('starts the stream with the persisted assistant id and historic model', async () => {
    await POST(request(), { params: Promise.resolve({ threadId: 'thread-1' }) });
    const config = mocks.createStream.mock.calls[0]![0];
    const writer = { write: vi.fn() };

    await config.execute({ writer });

    expect(writer.write).toHaveBeenNthCalledWith(1, {
      type: 'start',
      messageId: 'assistant-stable',
    });
    expect(mocks.begin).toHaveBeenCalledWith(
      'thread-1',
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({ messageId: 'assistant-old', modelId: 'historic-model' }),
    );
    expect(mocks.runNative).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'historic-model' }));
  });

  it('persists an HTTP-aborted response as cancelled, never completed', async () => {
    const controller = new AbortController();
    await POST(request(controller.signal), { params: Promise.resolve({ threadId: 'thread-1' }) });
    const config = mocks.createStream.mock.calls[0]![0];
    controller.abort();

    await config.onFinish({ responseMessage: { parts: [] }, isAborted: false });

    expect(mocks.finish).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'cancelled',
      undefined,
      'assistant-stable',
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
