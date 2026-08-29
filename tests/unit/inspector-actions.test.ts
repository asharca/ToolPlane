import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  sandboxFindFirst: vi.fn(),
  effectiveStatus: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  listMcpToolsViaSandbox: vi.fn(),
  mcpRpcViaSandbox: vi.fn(),
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
  logRequest: vi.fn(),
  SandboxMcpAuthenticationError: class SandboxMcpAuthenticationError extends Error {},
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    deployment: {
      findFirst: mocks.deploymentFindFirst,
      updateMany: mocks.deploymentUpdateMany,
    },
    sandbox: { findFirst: mocks.sandboxFindFirst },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: mocks.effectiveStatus }));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/process/sandbox-mcp-client', () => ({
  listMcpToolsViaSandbox: mocks.listMcpToolsViaSandbox,
  mcpRpcViaSandbox: mocks.mcpRpcViaSandbox,
  SandboxMcpAuthenticationError: mocks.SandboxMcpAuthenticationError,
}));
vi.mock('@/lib/process/mcp-client', () => ({
  listMcpTools: mocks.listMcpTools,
  mcpRpc: mocks.mcpRpc,
}));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));

import {
  connectMcpInspectorAction,
  runMcpInspectorToolAction,
} from '@/lib/workspace/inspector-actions';

const tool = { name: 'search', inputSchema: { type: 'object' } };
const remoteSpec = {
  kind: 'remote' as const,
  name: 'Remote',
  url: 'https://mcp.example.com/mcp',
  transport: 'streamable-http' as const,
  headers: { authorization: 'Bearer secret' },
  timeoutMs: 30_000,
};

function input(overrides: Record<string, string> = {}) {
  return { workspace: 'mine', deploymentId: 'remote-dep', sandboxId: 'sandbox-1', ...overrides };
}

describe('sandbox-backed MCP Inspector actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.deploymentFindFirst.mockImplementation(async (query: { select?: { updatedAt?: boolean } }) => (
      query.select?.updatedAt
        ? { installCfg: { env: { TOKEN: 'secret' } }, updatedAt: new Date('2026-08-29T00:00:00Z') }
        : {
            id: 'remote-dep',
            serverId: 'server-1',
            name: 'Remote',
            source: 'remote',
            sourceRef: remoteSpec.url,
            status: 'stopped',
            installCfg: {
              transport: 'streamable-http',
              env: { TOKEN: 'secret' },
              mcpInspector: { sandboxId: 'sandbox-1', connectedAt: '2026-08-29T00:00:00.000Z' },
            },
            server: { name: 'Remote' },
          }
    ));
    mocks.sandboxFindFirst.mockResolvedValue({
      deploymentId: 'sandbox-dep',
      network: 'isolated',
      deployment: { status: 'running' },
    });
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockReturnValue(remoteSpec);
    mocks.listMcpToolsViaSandbox.mockResolvedValue([tool]);
    mocks.mcpRpcViaSandbox.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it('discovers remotely through the selected workspace sandbox and persists only schema plus marker', async () => {
    await expect(connectMcpInspectorAction(input())).resolves.toEqual({ tools: [tool] });

    expect(mocks.sandboxFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'sandbox-1', workspaceId: 'workspace-1' }),
    }));
    expect(mocks.listMcpToolsViaSandbox).toHaveBeenCalledWith('sandbox-dep', remoteSpec);
    const update = mocks.deploymentUpdateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: 'remote-dep', workspaceId: 'workspace-1' });
    expect(update.data.installCfg).toMatchObject({
      toolCatalog: [tool],
      mcpInspector: { sandboxId: 'sandbox-1', connectedAt: expect.any(String) },
    });
    expect(JSON.stringify(update.data.installCfg)).not.toContain('authorization');
  });

  it('requires an owned, running, networked sandbox before any connector request', async () => {
    await expect(connectMcpInspectorAction(input({ sandboxId: '' }))).resolves.toEqual({
      error: 'sandboxRequired',
    });

    mocks.sandboxFindFirst.mockResolvedValueOnce(null);
    await expect(connectMcpInspectorAction(input({ sandboxId: 'foreign' }))).resolves.toEqual({
      error: 'sandboxNotFound',
    });

    mocks.sandboxFindFirst.mockResolvedValueOnce({
      deploymentId: 'sandbox-dep', network: 'none', deployment: { status: 'running' },
    });
    await expect(connectMcpInspectorAction(input())).resolves.toEqual({
      error: 'sandboxNetworkDisabled',
    });

    mocks.effectiveStatus.mockReturnValueOnce('stopped');
    await expect(connectMcpInspectorAction(input())).resolves.toEqual({
      error: 'sandboxNotRunning',
    });
    expect(mocks.listMcpToolsViaSandbox).not.toHaveBeenCalled();
  });

  it('requires configured connector credentials before any sandbox request', async () => {
    mocks.deploymentFindFirst.mockResolvedValueOnce({
      id: 'remote-dep',
      source: 'remote',
      sourceRef: remoteSpec.url,
      status: 'setup_required',
      installCfg: {
        transport: 'streamable-http',
        authType: 'bearer',
        bearerEnv: 'TOKEN',
        requiredEnv: ['TOKEN'],
        env: { TOKEN: '' },
      },
      server: { name: 'Remote', installCfg: null },
    });

    await expect(connectMcpInspectorAction(input())).resolves.toEqual({
      error: 'credentialsRequired',
    });
    expect(mocks.listMcpToolsViaSandbox).not.toHaveBeenCalled();
  });

  it('reports rejected connector credentials without exposing the remote error', async () => {
    mocks.listMcpToolsViaSandbox.mockRejectedValueOnce(new mocks.SandboxMcpAuthenticationError());

    await expect(connectMcpInspectorAction(input())).resolves.toEqual({
      error: 'authenticationFailed',
    });
  });

  it('rejects unsupported remote transports before process execution', async () => {
    mocks.deploymentFindFirst.mockResolvedValueOnce({
      id: 'remote-dep',
      source: 'remote',
      sourceRef: remoteSpec.url,
      status: 'stopped',
      installCfg: { transport: 'websocket' },
      server: { name: 'Remote' },
    });
    await expect(connectMcpInspectorAction(input())).resolves.toEqual({
      error: 'unsupportedTransport',
    });
    expect(mocks.listMcpToolsViaSandbox).not.toHaveBeenCalled();
  });

  it('lists and invokes a remote tool through the same sandbox path', async () => {
    await expect(runMcpInspectorToolAction({
      ...input(),
      toolName: 'search',
      arguments: { query: 'hello' },
    })).resolves.toEqual({ result: { content: [{ type: 'text', text: 'ok' }] } });

    expect(mocks.listMcpToolsViaSandbox).toHaveBeenCalledWith('sandbox-dep', remoteSpec);
    expect(mocks.mcpRpcViaSandbox).toHaveBeenCalledWith(
      'sandbox-dep',
      remoteSpec,
      'tools/call',
      { name: 'search', arguments: { query: 'hello' } },
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      deploymentId: 'remote-dep',
      path: expect.stringContaining('/inspector/sandbox-1#tools/call:search'),
    }));
  });

  it('redacts connector credentials from tool results and request logs', async () => {
    mocks.mcpRpcViaSandbox.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Bearer secret / secret' }],
    });

    await expect(runMcpInspectorToolAction({
      ...input(), toolName: 'search', arguments: {},
    })).resolves.toEqual({
      result: { content: [{ type: 'text', text: '[REDACTED] / [REDACTED]' }] },
    });
    expect(JSON.stringify(mocks.logRequest.mock.calls[0][0])).not.toContain('secret');
  });

  it('does not run a tool through a sandbox that has not explicitly connected', async () => {
    mocks.deploymentFindFirst.mockResolvedValueOnce({
      id: 'remote-dep',
      source: 'remote',
      sourceRef: remoteSpec.url,
      status: 'stopped',
      installCfg: {
        transport: 'streamable-http',
        mcpInspector: { sandboxId: 'different-sandbox', connectedAt: '2026-08-29T00:00:00.000Z' },
      },
      server: { name: 'Remote' },
    });

    await expect(runMcpInspectorToolAction({
      ...input(), toolName: 'search', arguments: {},
    })).resolves.toEqual({ error: 'sandboxRequired' });
    expect(mocks.mcpRpcViaSandbox).not.toHaveBeenCalled();
  });

  it('keeps non-remote MCP execution isolated while still enforcing the sandbox gate', async () => {
    mocks.deploymentFindFirst.mockResolvedValueOnce({
      id: 'local-dep',
      source: 'npm',
      sourceRef: 'example-mcp',
      status: 'running',
      installCfg: {},
      server: null,
    });
    mocks.listMcpTools.mockResolvedValue([tool]);

    await expect(connectMcpInspectorAction(input({ deploymentId: 'local-dep' }))).resolves.toEqual({
      tools: [tool],
    });
    expect(mocks.listMcpTools).toHaveBeenCalledWith('local-dep');
    expect(mocks.listMcpToolsViaSandbox).not.toHaveBeenCalled();
  });
});
