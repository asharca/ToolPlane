// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskState } from '@a2a-js/sdk';
import type { A2ATask } from '@prisma/client';
const mocks = vi.hoisted(() => ({ live: vi.fn(), target: vi.fn(), context: vi.fn(), agent: vi.fn(), run: vi.fn(), token: vi.fn() }));
vi.mock('@/lib/a2a/principal', () => ({ isLocalGrant: (g: { kind?: string }) => g.kind === 'local', assertLiveGrant: mocks.live }));
vi.mock('@/lib/a2a/local-policy', () => ({ localTarget: mocks.target }));
vi.mock('@/lib/db', () => ({ db: { a2AContext: { findFirst: mocks.context } } }));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRun: mocks.agent }));
vi.mock('@/lib/agents/resolve', () => ({ resolveAgentTools: () => ({ deploymentIds: ['live-mcp', 'stopped-mcp'], skills: [{ name: 'test-skill' }] }) }));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: (id: string) => id === 'live-mcp' ? 'running' : 'stopped' }));
vi.mock('@/lib/agents/model', () => ({ resolveModelContext: () => ({ maxTokens: 128000, estimated: false }) }));
vi.mock('@/lib/agents/sandbox-runtime', () => ({ runSandboxAgentTurn: mocks.run }));
vi.mock('@/lib/agents/runtime-access', () => ({ createAgentRuntimeToken: mocks.token,
  runtimeMcpProxyUrl: (id: string) => `https://proxy.test/mcp/${id}`, runtimeModelProxyBase: () => 'https://proxy.test/model', sandboxRuntimeOrigin: () => 'https://proxy.test' }));
import { executeLocalTask, LOCAL_COLLABORATION_INSTRUCTIONS } from '@/lib/a2a/local-executor';
const grant = { kind: 'local', workspaceId: 'ws', agentId: 'agent', ownerKey: 'owner', targetBinding: 'binding', expiresAt: Date.now() + 60_000 };
const row = () => ({ id: 'task', contextId: 'a2a-context', leaseToken: 'lease', grant, deadlineAt: new Date(Date.now() + 50_000),
  snapshot: { id: 'task', contextId: 'a2a-context', status: { state: 'TASK_STATE_WORKING' }, history: [
    { messageId: 'input', role: 'ROLE_USER', parts: [{ text: 'Review the patch' }] },
    { messageId: 'output', role: 'ROLE_AGENT', parts: [{ text: 'Progress' }] },
  ] } } as unknown as A2ATask);
const agent = { id: 'agent', runtimeKind: 'pi', provider: { id: 'provider', apiKey: 'fixture-secret' }, model: 'model', maxSteps: 10,
  disabledBuiltinTools: ['dangerous-tool'], systemPrompt: 'Follow task policy', publicRuntimeAllocation: null };
beforeEach(() => {
  vi.clearAllMocks(); mocks.live.mockResolvedValue(undefined); mocks.target.mockResolvedValue({ binding: 'binding', sandboxId: 'sandbox' });
  mocks.context.mockResolvedValue({ id: 'a2a-context' }); mocks.agent.mockResolvedValue(agent); mocks.token.mockResolvedValue('scoped-runtime-token'); mocks.run.mockResolvedValue('review result');
});
describe('native local TaskExecutor runtime port', () => {
  it.each(['pi', 'claude-code', 'dsh', 'hermes-rpc'])('projects a task-scoped %s turn without a private Conversation', async (runtimeKind) => {
    mocks.agent.mockResolvedValue({ ...agent, runtimeKind });
    const result = await executeLocalTask(row(), new AbortController().signal);
    expect(result.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(mocks.context.mock.calls[0][0].where).toMatchObject({ id: 'a2a-context', workspaceId: 'ws', agentId: 'agent', targetKind: 'local', targetBinding: 'binding' });
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ a2aTaskId: 'task', a2aLeaseToken: 'lease', deploymentIds: ['live-mcp'] });
    const projection = mocks.run.mock.calls[0][0];
    expect(projection).toMatchObject({ runtimeKind, runtimeSessionId: 'a2a-context', sandboxId: 'sandbox', runtimeAccessToken: 'scoped-runtime-token', modelId: 'model', disabledBuiltinTools: ['dangerous-tool'] });
    expect(projection.mcpServers).toEqual([{ deploymentId: 'live-mcp', url: 'https://proxy.test/mcp/live-mcp' }, { deploymentId: 'toolplane-a2a', url: 'https://proxy.test/api/v1/agent-runtime/a2a/task/mcp' }]);
    expect(projection.systemPrompt).toContain(LOCAL_COLLABORATION_INSTRUCTIONS);
    expect(projection.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(projection.mcpServers)).not.toContain('fixture-secret'); expect(mocks.live).toHaveBeenCalledTimes(2);
  });
  it('will not dispatch a public task or unclaimed local task', async () => {
    await expect(executeLocalTask({ ...row(), grant: {} }, new AbortController().signal)).rejects.toThrow();
    await expect(executeLocalTask({ ...row(), leaseToken: null }, new AbortController().signal)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects a changed context before projecting credentials', async () => {
    mocks.context.mockResolvedValue(null);
    await expect(executeLocalTask(row(), new AbortController().signal)).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it('does not publish a result when cancellation or authority revocation wins', async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async () => { controller.abort(); return 'late'; });
    await expect(executeLocalTask(row(), controller.signal)).rejects.toThrow();
    mocks.run.mockResolvedValue('late'); mocks.live.mockRejectedValue(new Error('revoked'));
    await expect(executeLocalTask(row(), new AbortController().signal)).rejects.toThrow();
  });
  it('rejects oversized output and does not convert executor errors to successful text', async () => {
    mocks.run.mockResolvedValue('x'.repeat(65537));
    await expect(executeLocalTask(row(), new AbortController().signal)).rejects.toThrow('output limit');
    mocks.run.mockRejectedValue(new Error('executor stopped'));
    await expect(executeLocalTask(row(), new AbortController().signal)).rejects.toThrow('executor stopped');
  });
});
