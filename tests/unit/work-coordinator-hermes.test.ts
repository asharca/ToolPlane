// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queued: true,
  workFindFirst: vi.fn(),
  workFindUnique: vi.fn(),
  workFindMany: vi.fn(),
  workCount: vi.fn(),
  workUpdateMany: vi.fn(),
  messageCreate: vi.fn(),
  getAgentForRun: vi.fn(),
  runHermesWork: vi.fn(),
  releaseLease: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    workSession: {
      findFirst: mocks.workFindFirst,
      findUnique: mocks.workFindUnique,
      findMany: mocks.workFindMany,
      count: mocks.workCount,
      updateMany: mocks.workUpdateMany,
    },
    message: { create: mocks.messageCreate },
    workApproval: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRun: mocks.getAgentForRun }));
vi.mock('@/lib/agents/mutations', () => ({
  ensureConversationRuntimeSession: vi.fn(async () => ({
    runtimeSessionId: 'conversation-1',
    runtimeSessionKey: 'agent:agent-1:console:conversation-1',
  })),
}));
vi.mock('@/lib/agents/resolve', () => ({
  resolveAgentTools: () => ({ deploymentIds: [], sandboxDeploymentIds: [], skills: [], subAgents: [] }),
}));
vi.mock('@/lib/agents/run', () => ({ buildAgentToolSet: vi.fn() }));
vi.mock('@/lib/agents/native', () => ({
  runNativeAgent: vi.fn(),
  uiMessagesToPi: (messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>) =>
    messages.map((message) => ({
      role: message.role,
      content: message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    })),
}));
vi.mock('@/lib/agents/sandbox-turn', () => ({ runDedicatedSandboxTurn: vi.fn() }));
vi.mock('@/lib/agents/hermes/work', () => ({
  runHermesWork: mocks.runHermesWork,
  stopHermesWorkRun: vi.fn(),
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: () => ({ release: mocks.releaseLease }),
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: 'Hermes maintenance in progress.',
}));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: vi.fn(), liveStatus: vi.fn() }));

describe('Hermes Work coordinator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.queued = true;
    delete (globalThis as { __workCoordinator?: unknown }).__workCoordinator;
    delete (globalThis as { __workRunControllers?: unknown }).__workRunControllers;
    delete (globalThis as { __workOutputChannels?: unknown }).__workOutputChannels;
    mocks.workFindFirst.mockImplementation(async () => mocks.queued ? {
      id: 'work-1', stepCount: 0, maxSteps: 12, deadlineAt: null, startedAt: null,
    } : null);
    mocks.workFindUnique.mockResolvedValue({
      id: 'work-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-hermes',
      conversationId: 'conversation-1',
      task: 'Inspect the repository',
      runtimeKind: 'hermes',
      runtimeSnapshot: { runtimeId: 'runtime-1', sandboxId: 'sandbox-hermes', workingDirectory: '.' },
      status: 'running',
      sandbox: {
        id: 'sandbox-hermes',
        deploymentId: 'deployment-hermes',
        deployment: { status: 'stopped' },
      },
      conversation: {
        messages: [{
          id: 'message-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the repository' }],
        }],
      },
    });
    mocks.workFindMany.mockResolvedValue([]);
    mocks.workCount.mockResolvedValue(1);
    mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.status === 'queued' && data.status === 'running') mocks.queued = false;
      return { count: 1 };
    });
    mocks.messageCreate.mockResolvedValue({ id: 'message-assistant' });
    mocks.getAgentForRun.mockResolvedValue({
      id: 'agent-1',
      slug: 'hermes-worker',
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      runtime: { id: 'runtime-1', kind: 'hermes', sandboxId: 'sandbox-hermes' },
      provider: null,
      model: null,
      modelProviders: [{ providerId: 'provider-1' }],
      systemPrompt: null,
      maxSteps: 12,
      servers: [],
      skills: [],
      toolkits: [],
      sandboxes: [],
    });
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onRunStarted?.('run-1');
      await options.onReasoningAvailable?.({ runId: 'run-1', timestamp: 1, text: 'Inspecting files' });
      await options.onToolStarted?.({ runId: 'run-1', timestamp: 2, tool: 'terminal', preview: 'pnpm test' });
      await options.onMessageDelta?.({ runId: 'run-1', timestamp: 3, delta: 'Done' });
      await options.onToolCompleted?.({ runId: 'run-1', timestamp: 4, tool: 'terminal', duration: 1.2, error: false });
      return { runId: 'run-1', status: 'completed', text: 'Done' };
    });
  });

  it('streams Hermes activity and persists the completed Work turn', async () => {
    const { kickWorkCoordinator } = await import('@/lib/work/coordinator');
    const { subscribeWorkOutput } = await import('@/lib/work/run-control');
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput('work-1', () => undefined);
    expect(snapshot).toMatchObject({ text: 'Done', done: true });
    expect(snapshot.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', text: 'Inspecting files\n', status: 'completed' }),
      expect.objectContaining({ type: 'tool', toolName: 'terminal', status: 'completed' }),
      expect.objectContaining({ type: 'runtime', runtimeKind: 'hermes', status: 'completed' }),
    ]));
    unsubscribe();
    expect(mocks.runHermesWork).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Inspect the repository',
      workingDirectory: '.',
      sessionId: 'conversation-1',
    }));
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        textCharacters: 4,
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: 'Inspecting files\n' }),
          expect.objectContaining({ type: 'work-tool', toolName: 'terminal', status: 'completed' }),
          { type: 'text', text: 'Done', state: 'done' },
        ]),
      }),
    });
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'work-1', status: 'running' },
      data: expect.objectContaining({ status: 'idle' }),
    }));
  });
});
