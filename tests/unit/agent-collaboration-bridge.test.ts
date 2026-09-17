// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), cancel: vi.fn(), token: vi.fn(), execute: vi.fn(), links: vi.fn(), context: vi.fn() }));
vi.mock('@/lib/observability/events', () => ({ observe: (_meta: unknown, operation: () => Promise<unknown>) => operation(), recordEvent: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agentSandbox: { findMany: mock.links } } }));
vi.mock('@/lib/agents/collaboration/service', () => ({ openCollaborationRun: mock.open, closeCollaborationRun: mock.close, cancelRunTasks: mock.cancel, assertCollaborationContext: mock.context }));
vi.mock('@/lib/agents/runtime-access', () => ({ createAgentRuntimeToken: mock.token, runtimeCollaborationMcpUrl: (id: string) => `https://tp.test/collaboration/${id}/mcp`, runtimeMcpProxyUrl: (id: string) => `https://tp.test/mcp/${id}`, runtimeModelProxyBase: () => 'https://tp.test/model' }));
vi.mock('@/lib/agents/hermes-rpc-session-binding', () => ({ bindHermesRpcConversation: vi.fn() }));
vi.mock('@/lib/agents/model', () => ({ resolveModelContext: () => ({ maxTokens: 128000, estimated: false }) }));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: () => 'running' }));
vi.mock('@/lib/agents/sandbox-runtime', () => ({ runSandboxAgentTurn: mock.execute, normalizeSandboxWorkingDirectory: () => '/workspace' }));
import { runDedicatedSandboxTurn } from '@/lib/agents/sandbox-turn';
const input = { agent: { id: 'a', workspaceId: 'w', runtimeKind: 'pi', disabledBuiltinTools: [], model: 'm', provider: { id: 'p', name: 'P', format: 'openai', baseUrl: 'https://model.test', apiKey: 'provider-secret' } },
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'delegate' }] }], deploymentIds: ['mcp-one'],
  runtimeSessionId: 'conversation', collaboration: { targetIds: ['child'] } };
beforeEach(() => {
  vi.clearAllMocks();
  mock.open.mockResolvedValue({ id: 'run-1', deadlineAt: new Date(Date.now() + 60000) });
  mock.close.mockResolvedValue(undefined); mock.cancel.mockResolvedValue(undefined);
  mock.context.mockResolvedValue(undefined);
  mock.token.mockResolvedValue('signed-runtime-grant'); mock.execute.mockResolvedValue('result');
  mock.links.mockResolvedValue([{ sandboxId: 's', isDefault: true, sandbox: { workspaceId: 'w', kind: 'docker', network: 'isolated' } }]);
});
describe('native runtime collaboration bridge', () => {
  it.each(['pi', 'claude-code', 'dsh', 'hermes-rpc'])('injects the same scoped MCP capability into %s', async (runtimeKind) => {
    await runDedicatedSandboxTurn({ ...input, agent: { ...input.agent, runtimeKind } });
    expect(mock.token).toHaveBeenCalledWith(expect.objectContaining({ collaborationRunId: 'run-1', deploymentIds: ['mcp-one'] }));
    expect(mock.execute).toHaveBeenCalledWith(expect.objectContaining({ runtimeAccessToken: 'signed-runtime-grant',
      mcpServers: [{ deploymentId: 'mcp-one', url: 'https://tp.test/mcp/mcp-one' },
        { deploymentId: 'toolplane-collaboration', url: 'https://tp.test/collaboration/run-1/mcp' }],
      systemPrompt: expect.stringContaining('asynchronous') }));
    expect(mock.close).toHaveBeenCalledWith('run-1');
  });
  it('does not issue collaboration authority without an explicit binding or delegated task', async () => {
    await runDedicatedSandboxTurn({ ...input, collaboration: { targetIds: [] } });
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.token).toHaveBeenCalledWith(expect.not.objectContaining({ collaborationRunId: expect.anything() }));
  });
  it('revokes the run and cancels descendants after an execution failure', async () => {
    mock.execute.mockRejectedValue(new Error('failed'));
    await expect(runDedicatedSandboxTurn(input)).rejects.toThrow('failed');
    expect(mock.cancel).toHaveBeenCalledWith('run-1'); expect(mock.close).toHaveBeenCalledWith('run-1');
  });
  it('refuses direct reuse of a reserved delegation context even without child bindings', async () => {
    mock.context.mockRejectedValue(new Error('reserved context'));
    await expect(runDedicatedSandboxTurn({ ...input, collaboration: { targetIds: [] } })).rejects.toThrow('reserved context');
    expect(mock.execute).not.toHaveBeenCalled();
  });
  it('does not route legacy Hermes through the new adapter', async () => {
    await expect(runDedicatedSandboxTurn({ ...input, agent: { ...input.agent, runtimeKind: 'hermes' } })).rejects.toThrow('Unsupported sandbox runtime');
    expect(mock.open).not.toHaveBeenCalled();
  });
});
