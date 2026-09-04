// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queued: true,
  workFindFirst: vi.fn(),
  workFindUnique: vi.fn(),
  workFindMany: vi.fn(),
  workCount: vi.fn(),
  workUpdateMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  messageCreate: vi.fn(),
  getAgentForRun: vi.fn(),
  resolveAgentTools: vi.fn(),
  runDedicatedSandboxTurn: vi.fn(),
  runHermesWork: vi.fn(),
  effectiveStatus: vi.fn(),
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
    deployment: { findMany: mocks.deploymentFindMany },
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
  resolveAgentTools: mocks.resolveAgentTools,
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
vi.mock('@/lib/agents/sandbox-turn', () => ({ runDedicatedSandboxTurn: mocks.runDedicatedSandboxTurn }));
vi.mock('@/lib/agents/hermes/work', () => ({
  runHermesWork: mocks.runHermesWork,
  stopHermesWorkRun: vi.fn(),
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: () => ({ release: mocks.releaseLease }),
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: 'Hermes maintenance in progress.',
}));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: mocks.effectiveStatus, liveStatus: vi.fn() }));

describe('Work coordinator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
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
        hermesProfile: 'research',
        hermesProvider: 'openrouter',
        hermesModel: 'model-a',
        reasoningEffort: 'high',
        messages: [{
          id: 'message-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the repository' }],
        }],
      },
    });
    mocks.workFindMany.mockResolvedValue([]);
    mocks.workCount.mockResolvedValue(1);
    mocks.deploymentFindMany.mockResolvedValue([]);
    mocks.resolveAgentTools.mockReturnValue({ deploymentIds: [], sandboxDeploymentIds: [], skills: [], subAgents: [] });
    mocks.effectiveStatus.mockReturnValue('running');
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
      expect.objectContaining({ type: 'tool', toolName: 'terminal', status: 'completed', durationMs: 1200 }),
      expect.objectContaining({ type: 'runtime', runtimeKind: 'hermes', status: 'completed' }),
    ]));
    expect(snapshot.activities.find((activity) => activity.toolName === 'terminal')?.durationMs).toBe(1200);
    unsubscribe();
    expect(mocks.runHermesWork).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Inspect the repository',
      workingDirectory: '.',
      sessionId: 'conversation-1',
      profile: 'research',
      provider: 'openrouter',
      model: 'model-a',
      reasoningEffort: 'high',
    }));
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        textCharacters: 4,
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: 'Inspecting files\n' }),
          expect.objectContaining({ type: 'work-tool', toolName: 'terminal', status: 'completed', durationMs: 1200 }),
          { type: 'text', text: 'Done', state: 'done' },
          expect.objectContaining({
            type: 'data-work-timing',
            data: expect.objectContaining({ runtimeKind: 'hermes', modelName: 'model-a', startedAt: expect.any(Number), completedAt: expect.any(Number), durationMs: expect.any(Number) }),
          }),
        ]),
      }),
    });
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'work-1', status: 'running' },
      data: expect.objectContaining({ status: 'idle' }),
    }));
  });

  it('keeps live activity order when the runtime fails', async () => {
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onReasoningAvailable?.({ runId: 'run-1', timestamp: 1, text: 'Inspecting files' });
      await options.onToolStarted?.({ runId: 'run-1', timestamp: 2, tool: 'terminal', preview: 'pnpm test' });
      await options.onToolCompleted?.({ runId: 'run-1', timestamp: 3, tool: 'terminal', duration: 1.2, error: false });
      return { runId: 'run-1', status: 'failed', text: '', error: 'Runtime stopped' };
    });

    const { kickWorkCoordinator } = await import('@/lib/work/coordinator');
    const { subscribeWorkOutput } = await import('@/lib/work/run-control');
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput('work-1', () => undefined);
    expect(snapshot.activities.map(({ id, type, status }) => ({ id, type, status }))).toEqual([
      { id: 'runtime', type: 'runtime', status: 'running' },
      { id: 'reasoning:1', type: 'reasoning', status: 'completed' },
      { id: 'tool:hermes:run-1:tool:1', type: 'tool', status: 'completed' },
      { id: 'runtime:final', type: 'runtime', status: 'failed' },
    ]);
    unsubscribe();
  });

  it('labels Hermes MCP tools with the workspace deployment and original name', async () => {
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: ['dep', 'dep-mcp'], sandboxDeploymentIds: [], skills: [], subAgents: [],
    });
    mocks.deploymentFindMany.mockResolvedValue([{
      id: 'dep', serverId: null, server: null, name: 'Wrong prefix MCP', source: 'custom', sourceRef: null,
    }, {
      id: 'dep-mcp', serverId: null, server: null, name: 'Filesystem MCP', source: 'custom', sourceRef: null,
    }]);
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onToolStarted?.({ runId: 'run-1', timestamp: 1, tool: 'dep-mcp__read/file', preview: 'README.md' });
      await options.onToolCompleted?.({ runId: 'run-1', timestamp: 2, tool: 'dep-mcp__read/file', duration: 0.2, error: false });
      return { runId: 'run-1', status: 'completed', text: 'Done' };
    });

    const { kickWorkCoordinator } = await import('@/lib/work/coordinator');
    const { subscribeWorkOutput } = await import('@/lib/work/run-control');
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput('work-1', () => undefined);
    expect(snapshot.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'dep-mcp__read/file',
        deploymentName: 'Filesystem MCP',
        originalToolName: 'read/file',
        durationMs: 200,
      }),
    ]));
    unsubscribe();
    expect(mocks.deploymentFindMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1', id: { in: ['dep', 'dep-mcp'] } },
      select: {
        id: true,
        serverId: true,
        name: true,
        source: true,
        sourceRef: true,
        server: { select: { name: true } },
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: 'work-tool',
            toolName: 'dep-mcp__read/file',
            deploymentName: 'Filesystem MCP',
            originalToolName: 'read/file',
          }),
        ]),
      }),
    });
  });

  it('persists reachable Pi Work process events in order', async () => {
    mocks.workFindUnique.mockResolvedValue({
      id: 'work-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-pi',
      conversationId: 'conversation-1',
      task: 'Inspect the repository',
      runtimeKind: 'pi',
      runtimeSnapshot: { workingDirectory: '.' },
      status: 'running',
      sandbox: {
        id: 'sandbox-pi',
        deploymentId: 'deployment-pi',
        deployment: { status: 'running' },
      },
      conversation: {
        messages: [{
          id: 'message-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the repository' }],
        }],
      },
    });
    mocks.getAgentForRun.mockResolvedValue({
      id: 'agent-1',
      slug: 'pi-worker',
      workspaceId: 'workspace-1',
      runtimeKind: 'pi',
      runtime: null,
      provider: { name: 'P', format: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret' },
      model: 'model-a',
      modelProviders: [],
      systemPrompt: null,
      maxSteps: 12,
      servers: [],
      skills: [],
      toolkits: [],
      sandboxes: [],
    });
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: ['dep-mcp'], sandboxDeploymentIds: [], skills: [], subAgents: [],
    });
    mocks.deploymentFindMany.mockResolvedValue([{
      id: 'dep-mcp', serverId: null, server: null, name: 'Filesystem MCP', source: 'custom', sourceRef: null,
    }]);
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      await options.onActivity?.({ type: 'reasoning', status: 'running', delta: 'Checking files' });
      await options.onActivity?.({ type: 'reasoning', status: 'completed' });
      await options.onActivity?.({
        type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'mcp__s1_t1__read_file', deploymentId: 'dep-mcp', input: { path: 'README.md' },
      });
      await options.onActivity?.({
        type: 'tool', status: 'running', toolCallId: 'call-1', deploymentId: 'dep-mcp', originalToolName: 'read/file',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await options.onActivity?.({
        type: 'tool', status: 'completed', toolCallId: 'call-1', output: { contents: 'ToolPlane' },
      });
      await options.onTextDelta?.('Done');
      await options.onContextUsage?.({ usedTokens: 10, maxTokens: 100, modelName: 'model-a', estimated: false });
      return 'Done';
    });

    const { kickWorkCoordinator } = await import('@/lib/work/coordinator');
    const { subscribeWorkOutput } = await import('@/lib/work/run-control');
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledTimes(1));
    expect(mocks.runDedicatedSandboxTurn).toHaveBeenCalledOnce();
    const { snapshot, unsubscribe } = subscribeWorkOutput('work-1', () => undefined);
    expect(snapshot).toMatchObject({ text: 'Done', done: true });
    expect(snapshot.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', text: 'Checking files', status: 'completed' }),
      expect.objectContaining({
        type: 'tool', toolCallId: 'call-1', toolName: 'mcp__s1_t1__read_file', deploymentName: 'Filesystem MCP', originalToolName: 'read/file', input: { path: 'README.md' },
        output: { contents: 'ToolPlane' }, status: 'completed', durationMs: expect.any(Number),
      }),
    ]));
    expect(snapshot.activities.find((activity) => activity.toolCallId === 'call-1')?.durationMs).toBeGreaterThan(0);
    unsubscribe();
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        textCharacters: 4,
        parts: [
          { type: 'reasoning', text: 'Checking files', state: 'done' },
          expect.objectContaining({
            type: 'work-tool', toolCallId: 'call-1', toolName: 'mcp__s1_t1__read_file', deploymentName: 'Filesystem MCP', originalToolName: 'read/file', input: { path: 'README.md' },
            output: { contents: 'ToolPlane' }, isError: false, status: 'completed', durationMs: expect.any(Number),
          }),
          { type: 'text', text: 'Done', state: 'done' },
          { type: 'data-context-usage', data: { usedTokens: 10, maxTokens: 100, modelName: 'model-a', estimated: false } },
          expect.objectContaining({
            type: 'data-work-timing',
            data: expect.objectContaining({ runtimeKind: 'pi', modelName: 'model-a', startedAt: expect.any(Number), completedAt: expect.any(Number), durationMs: expect.any(Number) }),
          }),
        ],
      }),
    });
  });
});
