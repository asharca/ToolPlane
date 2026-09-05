// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationUpdateMany: vi.fn(),
  appendMessage: vi.fn(),
  ensureConversationRuntimeSession: vi.fn(),
  writeHermesChatStream: vi.fn(),
  acquireHermesRuntimeWriteLease: vi.fn(),
  hermesAssistantSegments: vi.fn(),
  transaction: vi.fn(),
  messageCreate: vi.fn(),
  resolveAgentTools: vi.fn(),
  runDedicatedSandboxTurn: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRequest: mocks.getAgentForRequest }));
vi.mock('@/lib/db', () => ({
  db: {
    conversation: {
      findFirst: mocks.conversationFindFirst,
      updateMany: mocks.conversationUpdateMany,
    },
    message: { create: mocks.messageCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/agents/mutations', () => ({
  appendMessage: mocks.appendMessage,
  ensureConversationRuntimeSession: mocks.ensureConversationRuntimeSession,
}));
vi.mock('@/lib/agents/resolve', () => ({ resolveAgentTools: mocks.resolveAgentTools }));
vi.mock('@/lib/agents/system-prompt', () => ({ assembleSystemPrompt: vi.fn() }));
vi.mock('@/lib/agents/run', () => ({ buildAgentToolSet: vi.fn() }));
vi.mock('@/lib/agents/native', () => ({ uiMessagesToPi: vi.fn(), runNativeAgent: vi.fn() }));
vi.mock('@/lib/agents/hermes/client', () => ({ writeHermesChatStream: mocks.writeHermesChatStream }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: mocks.acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: 'Runtime busy',
}));
vi.mock('@/lib/agents/hermes/message-segments', () => ({
  hermesAssistantSegments: mocks.hermesAssistantSegments,
}));
vi.mock('@/lib/agents/sandbox-turn', () => ({
  runDedicatedSandboxTurn: mocks.runDedicatedSandboxTurn,
}));

import { POST } from '@/app/api/v1/agents/[agentId]/chat/route';

const context = { params: Promise.resolve({ agentId: 'agent-1' }) };

function request(body: unknown) {
  return new Request('http://toolplane.test/api/v1/agents/agent-1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Chat and Work execution boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'pi',
      runtime: null,
      provider: { id: 'provider-1' },
      model: 'model-1',
      modelProviders: [],
    });
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.resolveAgentTools.mockReturnValue({ skills: [], deploymentIds: [] });
    mocks.runDedicatedSandboxTurn.mockResolvedValue('done');
  });

  it('persists and snapshots the selected reasoning effort for Hermes', async () => {
    const release = vi.fn();
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      runtime: { id: 'runtime-1', kind: 'hermes' },
      provider: null,
      model: null,
      modelProviders: [{ provider: { id: 'provider-1' } }],
    });
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      title: null,
      hermesProfile: null,
      hermesProvider: null,
      hermesModel: null,
      reasoningEffort: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.ensureConversationRuntimeSession.mockResolvedValue({
      runtimeSessionId: 'conversation-1',
      runtimeSessionKey: 'session-key',
    });
    mocks.acquireHermesRuntimeWriteLease.mockReturnValue({ release });
    mocks.writeHermesChatStream.mockResolvedValue({ runtimeSessionId: 'conversation-1' });
    mocks.hermesAssistantSegments.mockReturnValue([]);

    const response = await POST(request({
      conversationId: 'conversation-1',
      reasoningEffort: 'high',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Think carefully' }] }],
    }), context);
    await response.text();

    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'conversation-1',
        agentId: 'agent-1',
        agent: { workspaceId: 'workspace-1' },
      },
      data: { reasoningEffort: 'high' },
    });
    expect(mocks.writeHermesChatStream).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'high',
    }));
  });

  it('holds the Hermes write lease until a cancelled turn actually exits', async () => {
    const release = vi.fn();
    let finishTurn!: (value: { runtimeSessionId: string }) => void;
    const turn = new Promise<{ runtimeSessionId: string }>((resolve) => { finishTurn = resolve; });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      runtime: { id: 'runtime-1', kind: 'hermes' },
      provider: null,
      model: null,
      modelProviders: [{ provider: { id: 'provider-1' } }],
    });
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      title: null,
      hermesProfile: null,
      hermesProvider: null,
      hermesModel: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.ensureConversationRuntimeSession.mockResolvedValue({
      runtimeSessionId: 'conversation-1',
      runtimeSessionKey: 'session-key',
    });
    mocks.acquireHermesRuntimeWriteLease.mockReturnValue({ release });
    mocks.writeHermesChatStream.mockReturnValue(turn);

    const response = await POST(request({
      conversationId: 'conversation-1',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }), context);
    const cancellation = response.body!.cancel();
    await vi.waitFor(() => expect(mocks.writeHermesChatStream).toHaveBeenCalled());

    expect(release).not.toHaveBeenCalled();
    expect(mocks.writeHermesChatStream).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    finishTurn({ runtimeSessionId: 'conversation-1' });
    await cancellation;

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });

  it('persists Hermes compression rollover before completing a successful turn', async () => {
    const release = vi.fn();
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      runtime: { id: 'runtime-1', kind: 'hermes' },
      provider: null,
      model: null,
      modelProviders: [{ provider: { id: 'provider-1' } }],
    });
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      title: null,
      hermesProfile: null,
      hermesProvider: null,
      hermesModel: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.ensureConversationRuntimeSession.mockResolvedValue({
      runtimeSessionId: 'conversation-1',
      runtimeSessionKey: 'session-key',
    });
    mocks.acquireHermesRuntimeWriteLease.mockReturnValue({ release });
    mocks.writeHermesChatStream.mockResolvedValue({ runtimeSessionId: 'conversation-child' });
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.hermesAssistantSegments.mockReturnValue([]);
    mocks.appendMessage
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(persistence);

    const response = await POST(request({
      conversationId: 'conversation-1',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }), context);
    const body = response.text();

    await vi.waitFor(() => expect(mocks.appendMessage).toHaveBeenCalledTimes(2));
    expect(release).not.toHaveBeenCalled();
    finishPersistence();
    await body;

    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'conversation-1',
        agentId: 'agent-1',
        runtimeSessionId: 'conversation-1',
      }),
      data: { runtimeSessionId: 'conversation-child' },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects the legacy workSessionId transport', async () => {
    const response = await POST(request({ messages: [], workSessionId: 'work-1' }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Work sessions must use the Work API');
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();
  });

  it('does not let Chat write into a Work conversation', async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      workSession: { id: 'work-1' },
    });
    const response = await POST(request({ messages: [], conversationId: 'conversation-1' }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Work conversations must use the Work API');
  });

  it('requires a saved Agent conversation for native attachments', async () => {
    const response = await POST(request({
      messages: [{
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'file', url: '/api/v1/attachments/attachment-1' }],
      }],
    }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Attachments require a saved conversation.');
  });

  it('does not persist a failed sandbox turn as an empty assistant reply', async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      title: null,
      reasoningEffort: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.runDedicatedSandboxTurn.mockRejectedValue(new Error('Runtime failed'));

    const response = await POST(request({
      conversationId: 'conversation-1',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }), context);

    expect(await response.text()).toContain('Runtime failed');
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });

  it('persists a completed sandbox turn', async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      title: null,
      reasoningEffort: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.runDedicatedSandboxTurn.mockImplementation(async ({ onTextDelta }) => {
      await onTextDelta?.('OK');
      return 'OK';
    });

    const response = await POST(request({
      conversationId: 'conversation-1',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }), context);
    await response.text();

    expect(mocks.appendMessage).toHaveBeenNthCalledWith(
      2,
      'conversation-1',
      'assistant',
      [{ type: 'text', text: 'OK', state: 'done' }],
    );
  });
});
