// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  agentFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  messageCreate: vi.fn(),
  workCreate: vi.fn(),
  workUpdateMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  workFindFirst: vi.fn(),
}));

const tx = {
  agent: { findFirst: mocks.agentFindFirst },
  conversation: {
    create: mocks.conversationCreate,
    update: mocks.conversationUpdate,
  },
  message: { create: mocks.messageCreate },
  workSession: {
    create: mocks.workCreate,
    updateMany: mocks.workUpdateMany,
    findFirst: mocks.workFindFirst,
  },
  workApproval: { updateMany: mocks.approvalUpdateMany },
};

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    workSession: {
      updateMany: mocks.workUpdateMany,
      findFirst: mocks.workFindFirst,
    },
  },
}));

vi.mock('@/lib/agents/mutations', () => ({
  defaultConversationRuntimeSession: (agentId: string, conversationId: string) => ({
    runtimeSessionId: conversationId,
    runtimeSessionKey: `agent:${agentId}:console:${conversationId}`,
  }),
}));

import {
  appendWorkSessionInput,
  cancelWorkSession,
  createWorkSession,
  finalizeWorkSessionCancellation,
  normalizeWorkDirectory,
  resumeWorkSession,
  transitionWorkSession,
} from '@/lib/work/sessions';
import { canTransitionWorkSession } from '@/lib/work/state-machine';

describe('WorkSession coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.agentFindFirst.mockResolvedValue({
      id: 'agent-1',
      providerId: 'provider-1',
      model: 'model-1',
      runtimeKind: 'pi',
      systemPrompt: null,
      maxSteps: 8,
      modelProviders: [],
      runtime: null,
      servers: [],
      skills: [],
      toolkits: [],
      subAgents: [],
      knowledgeBases: [],
      sandboxes: [{
        sandboxId: 'sandbox-1',
        isDefault: true,
        sandbox: { kind: 'docker', network: 'isolated' },
      }],
    });
    mocks.conversationCreate.mockResolvedValue({ id: 'conversation-1' });
    mocks.conversationUpdate.mockResolvedValue({ id: 'conversation-1' });
    mocks.messageCreate.mockResolvedValue({ id: 'message-1' });
    mocks.workCreate.mockImplementation(async ({ data }) => ({ id: 'work-1', ...data }));
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('creates queued work and its first user message in one transaction', async () => {
    const work = await createWorkSession({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-1',
      task: '  Build and test it  ',
    });

    expect(work).toMatchObject({ id: 'work-1', status: 'queued', task: 'Build and test it' });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: 'conversation-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Build and test it' }],
        textCharacters: 17,
      },
    });
    expect(mocks.messageCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.workCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runtimeKind: 'pi',
        runtimeSnapshot: expect.objectContaining({ workingDirectory: '.' }),
      }),
    }));
  });

  it('creates Hermes Work on its managed runtime sandbox', async () => {
    mocks.agentFindFirst.mockResolvedValueOnce({
      id: 'agent-1',
      providerId: null,
      model: null,
      runtimeKind: 'hermes',
      systemPrompt: null,
      maxSteps: 8,
      modelProviders: [{ providerId: 'provider-1' }],
      runtime: {
        id: 'runtime-1',
        kind: 'hermes',
        sandboxId: 'sandbox-hermes',
        sandbox: { id: 'sandbox-hermes', workspaceId: 'workspace-1', kind: 'hermes', network: 'isolated' },
      },
      servers: [],
      skills: [],
      toolkits: [],
      knowledgeBases: [],
      sandboxes: [],
    });

    await expect(createWorkSession({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-hermes',
      task: 'Build it',
      reasoningEffort: 'high',
      hermesSelection: { profile: 'research', provider: 'openrouter', model: 'model-b' },
    })).resolves.toMatchObject({
      sandboxId: 'sandbox-hermes',
      runtimeKind: 'hermes',
      status: 'queued',
    });
    expect(mocks.workCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sandboxId: 'sandbox-hermes',
        runtimeSnapshot: expect.objectContaining({ runtimeId: 'runtime-1', sandboxId: 'sandbox-hermes' }),
      }),
    }));
    expect(mocks.conversationCreate).toHaveBeenCalledWith({
      data: {
        agentId: 'agent-1',
        title: 'Build it',
        reasoningEffort: 'high',
        hermesProfile: 'research',
        hermesProvider: 'openrouter',
        hermesModel: 'model-b',
      },
    });
  });

  it('rejects a sandbox that is not the Hermes Agent runtime sandbox', async () => {
    mocks.agentFindFirst.mockResolvedValueOnce({
      id: 'agent-1',
      providerId: null,
      model: null,
      runtimeKind: 'hermes',
      systemPrompt: null,
      maxSteps: 8,
      modelProviders: [{ providerId: 'provider-1' }],
      runtime: {
        id: 'runtime-1',
        kind: 'hermes',
        sandboxId: 'sandbox-hermes',
        sandbox: { id: 'sandbox-hermes', workspaceId: 'workspace-1', kind: 'hermes', network: 'isolated' },
      },
      servers: [],
      skills: [],
      toolkits: [],
      knowledgeBases: [],
      sandboxes: [],
    });

    await expect(createWorkSession({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-other',
      task: 'Build it',
    })).resolves.toBeNull();
    expect(mocks.conversationCreate).not.toHaveBeenCalled();
  });

  it('normalizes sandbox working directories without allowing traversal', () => {
    expect(normalizeWorkDirectory('/workspace/projects/toolplane')).toBe('projects/toolplane');
    expect(normalizeWorkDirectory('/opt/data/workspace/projects/toolplane')).toBe('projects/toolplane');
    expect(normalizeWorkDirectory('projects/../app')).toBe('app');
    expect(normalizeWorkDirectory('../private')).toBeNull();
    expect(normalizeWorkDirectory('/etc')).toBeNull();
  });

  it('rejects an empty task before opening a transaction', async () => {
    await expect(createWorkSession({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      task: '   ',
    })).resolves.toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('moves a finished turn to idle without ending the session', async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(transitionWorkSession('workspace-1', 'work-1', 'idle', {
      result: 'done',
    })).resolves.toEqual({ ok: true, changed: true, status: 'idle' });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'work-1',
        workspaceId: 'workspace-1',
        status: { in: ['queued', 'running', 'waiting_user', 'cancelling'] },
      },
      data: { status: 'idle', result: 'done' },
    });

    mocks.workUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.workFindFirst.mockResolvedValueOnce({ status: 'idle' });
    await expect(transitionWorkSession('workspace-1', 'work-1', 'idle', {
      result: 'replacement',
    })).resolves.toEqual({ ok: true, changed: false, status: 'idle' });
  });

  it('rejects illegal terminal transitions', async () => {
    expect(canTransitionWorkSession('completed', 'running')).toBe(false);
    expect(canTransitionWorkSession('completed', 'queued')).toBe(true);
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.workFindFirst.mockResolvedValueOnce({ status: 'completed' });

    await expect(transitionWorkSession('workspace-1', 'work-1', 'running')).resolves.toEqual({
      ok: false,
      reason: 'invalid_transition',
      status: 'completed',
    });
  });

  it('atomically appends requested user input and requeues the work', async () => {
    mocks.workFindFirst.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      status: 'waiting_user',
    });
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(appendWorkSessionInput(
      'workspace-1',
      'work-1',
      '  Use PostgreSQL  ',
      { reasoningEffort: 'high' },
    )).resolves.toEqual({ ok: true, changed: true, status: 'queued' });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: { id: 'work-1', workspaceId: 'workspace-1', status: 'waiting_user' },
      data: {
        status: 'queued',
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: 'conversation-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Use PostgreSQL' }],
        textCharacters: 14,
      },
    });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: { reasoningEffort: 'high' },
    });
  });

  it('queues a fresh turn from idle', async () => {
    mocks.workFindFirst.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      status: 'idle',
    });
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(appendWorkSessionInput(
      'workspace-1',
      'work-1',
      'Do the next thing',
    )).resolves.toEqual({ ok: true, changed: true, status: 'queued' });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: { id: 'work-1', workspaceId: 'workspace-1', status: 'idle' },
      data: {
        status: 'queued',
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
  });

  it.each(['completed', 'failed'] as const)('accepts a new turn from legacy %s work', async (status) => {
    mocks.workFindFirst.mockResolvedValueOnce({ conversationId: 'conversation-1', status });
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(appendWorkSessionInput(
      'workspace-1',
      'work-1',
      'Continue working',
    )).resolves.toEqual({ ok: true, changed: true, status: 'queued' });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'work-1', workspaceId: 'workspace-1', status },
      data: expect.objectContaining({ status: 'queued' }),
    }));
  });

  it('moves active work through cancelling before the runner confirms cancellation', async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(cancelWorkSession('workspace-1', 'work-1')).resolves.toEqual({
      ok: true,
      changed: true,
      status: 'cancelling',
    });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['running', 'waiting_approval'] } }),
      data: expect.objectContaining({ status: 'cancelling' }),
    }));
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { workSessionId: 'work-1', status: 'pending' },
      data: { status: 'expired', resolvedAt: expect.any(Date) },
    });
  });

  it('stops queued work at idle and finalizes an active cancellation at idle', async () => {
    mocks.workUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(cancelWorkSession('workspace-1', 'work-1')).resolves.toEqual({
      ok: true,
      changed: true,
      status: 'idle',
    });
    expect(mocks.workUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['queued', 'waiting_user'] } }),
      data: expect.objectContaining({ status: 'idle' }),
    }));

    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(finalizeWorkSessionCancellation('workspace-1', 'work-1')).resolves.toBe(true);
    expect(mocks.workUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'work-1', workspaceId: 'workspace-1', status: 'cancelling' },
      data: expect.objectContaining({ status: 'idle' }),
    }));
  });

  it('requeues a failed task when it is explicitly resumed', async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(resumeWorkSession('workspace-1', 'work-1')).resolves.toEqual({
      ok: true,
      changed: true,
      status: 'queued',
    });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: { id: 'work-1', workspaceId: 'workspace-1', status: 'failed' },
      data: {
        status: 'queued',
        result: null,
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
  });
});
