// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { NativeRunOptions } from '@/lib/agents/native';

const mocks = vi.hoisted(() => ({
  begin: vi.fn(), buildKeylessWebSearch: vi.fn(), buildTools: vi.fn(),
  complete: vi.fn(), finish: vi.fn(), getHistory: vi.fn(), getThread: vi.fn(),
  hydrate: vi.fn(), resolveUser: vi.fn(), runNative: vi.fn(), access: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { chatTurn: { findFirst: mocks.access } } }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveUser }));
vi.mock('@/lib/workspace/access-stream', () => ({ workspaceAccessResponse: (response: Response) => response }));
vi.mock('@/lib/agents/tools', () => ({ buildToolSet: mocks.buildTools }));
vi.mock('@/lib/chat/keyless-web-search', () => ({ buildKeylessWebSearchToolSet: mocks.buildKeylessWebSearch }));
vi.mock('@/lib/agents/native', () => ({ runNativeAgent: mocks.runNative, uiMessagesToPi: () => [] }));
vi.mock('@/lib/attachments/messages', () => ({
  AttachmentMessageError: class AttachmentMessageError extends Error {},
  hydrateWorkspaceAttachmentMessages: mocks.hydrate,
}));
vi.mock('@/lib/chat/service', () => ({
  CHAT_TURN_STALE_AFTER_MS: 300_000,
  ChatServiceError: class ChatServiceError extends Error {},
  beginChatTurn: mocks.begin, completeChatTurn: mocks.complete, finishChatTurn: mocks.finish,
  getChatHistoryForExecution: mocks.getHistory, getChatThreadForExecution: mocks.getThread,
}));

import { POST, DELETE } from '@/app/api/v1/chat/threads/[threadId]/turns/route';
import { GET } from '@/app/api/v1/chat/threads/[threadId]/turns/stream/route';
const params = { params: Promise.resolve({ threadId: 'thread-1' }) };
const url = 'http://toolplane.test/api/v1/chat/threads/thread-1/turns';
function request(signal?: AbortSignal, webSearchEnabled = false) {
  return new Request(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Retry' }] }],
    trigger: 'regenerate-message', messageId: 'assistant-old', webSearchEnabled, reasoningEffort: 'high',
  }) });
}
function stop(turnId = 'turn-1') {
  return DELETE(new Request(url, { method: 'DELETE', body: JSON.stringify({ turnId }) }), params);
}
async function text(options: NativeRunOptions, delta: string) {
  await options.onEvent?.({ type: 'text_delta', contentIndex: 0, delta, partial: {} as AssistantMessage });
}

describe('server-owned assistant turns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUser.mockResolvedValue({ id: 'user-1' });
    mocks.getThread.mockResolvedValue({
      workspaceId: 'workspace-1',
      branch: { activeMessageId: 'assistant-stable', nodes: [{ id: 'assistant-old', modelId: 'historic-model' }] },
      assistant: { id: 'assistant-1', modelProvider: { id: 'provider-1' }, model: 'current-model',
        mcpGrants: [], systemPrompt: null, modelParameters: { temperature: 0.4 }, maxSteps: 5 },
    });
    mocks.begin.mockResolvedValue({ id: 'turn-1', assistantMessageId: 'assistant-stable', historyLeafId: 'user-1' });
    mocks.buildTools.mockResolvedValue({});
    mocks.buildKeylessWebSearch.mockReturnValue({ web_search: {} });
    mocks.getHistory.mockResolvedValue([]);
    mocks.hydrate.mockResolvedValue([]);
    mocks.access.mockResolvedValue({ id: 'turn-1' });
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => { await text(options, 'Saved answer'); });
  });

  it('finishes and persists after disconnect, replays without invoking the model twice', async () => {
    const gate = Promise.withResolvers<void>();
    let executionSignal: AbortSignal | undefined;
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      executionSignal = options.signal;
      await text(options, 'Before ');
      await gate.promise;
      await text(options, 'after disconnect');
    });
    const controller = new AbortController();
    const response = await POST(request(controller.signal, true), params);
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    controller.abort();
    await reader.cancel();
    expect(executionSignal!.aborted).toBe(false);
    expect(mocks.buildKeylessWebSearch.mock.calls[0]![0].aborted).toBe(false);
    const resumed = await GET(new Request(`${url}/stream`), params);
    gate.resolve();
    const replay = await resumed.text();
    expect(replay).toContain('Before ');
    expect(replay).toContain('after disconnect');
    expect(mocks.complete).toHaveBeenCalledWith('thread-1', 'turn-1', 'assistant-stable', [
      expect.objectContaining({ type: 'text', text: 'Before after disconnect' }),
    ]);
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.runNative).toHaveBeenCalledTimes(1);
    expect(mocks.runNative).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'historic-model', reasoningEffort: 'high' }));
  });

  it('explicit stop aborts execution and preserves the partial answer', async () => {
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      await text(options, 'Partial answer');
      await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    });
    const response = await POST(request(), params);
    await vi.waitFor(() => expect(mocks.runNative).toHaveBeenCalled());
    expect(await (await stop('old-turn')).json()).toEqual({ cancelled: false });
    expect(await (await stop()).json()).toEqual({ cancelled: true });
    expect(await response.text()).toContain('"type":"abort"');
    expect(mocks.finish).toHaveBeenCalledWith('thread-1', 'turn-1', 'cancelled', expect.any(String), 'assistant-stable', [
      expect.objectContaining({ type: 'text', text: 'Partial answer' }),
    ]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('never completes a model failure as success', async () => {
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      await text(options, 'Partial');
      throw new Error('Provider failed');
    });
    const response = await POST(request(), params);
    expect(await response.text()).toContain('Provider failed');
    expect(mocks.finish).toHaveBeenCalledWith('thread-1', 'turn-1', 'failed', 'Provider failed', 'assistant-stable', [
      expect.objectContaining({ type: 'text', text: 'Partial' }),
    ]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([401, 404])('rejects replay and cancellation without access (%s)', async (status) => {
    if (status === 401) mocks.resolveUser.mockResolvedValue(null);
    else mocks.getThread.mockResolvedValue(null);
    expect((await GET(new Request(`${url}/stream`), params)).status).toBe(status);
    expect((await stop()).status).toBe(status);
  });

  it('returns no stream for a different branch', async () => {
    const response = await POST(request(), params);
    await response.text();
    const thread = await mocks.getThread();
    mocks.getThread.mockResolvedValue({ ...thread, branch: { ...thread.branch, activeMessageId: 'other-branch' } });
    expect((await GET(new Request(`${url}/stream`), params)).status).toBe(204);
  });
});
