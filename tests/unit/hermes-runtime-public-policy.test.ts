// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeFindUnique: vi.fn(),
  getAgent: vi.fn(),
  verifyToken: vi.fn(),
  liveStatus: vi.fn(),
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
  loadMcpToolPolicies: vi.fn(),
  logRequest: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { agentRuntime: { findUnique: mocks.runtimeFindUnique } },
}));
vi.mock('@/lib/agents/queries', () => ({ getAgent: mocks.getAgent }));
vi.mock('@/lib/agents/hermes/token', () => ({
  verifyHermesRuntimeToken: mocks.verifyToken,
}));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: mocks.liveStatus }));
vi.mock('@/lib/process/mcp-client', () => ({
  listMcpTools: mocks.listMcpTools,
  mcpRpc: mocks.mcpRpc,
}));
vi.mock('@/lib/workspace/mcp-tool-exposure', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/workspace/mcp-tool-exposure')>(),
  loadMcpToolPolicies: mocks.loadMcpToolPolicies,
}));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));

import { POST } from '@/app/api/v1/agent-runtimes/[runtimeId]/mcp/route';

const context = { params: Promise.resolve({ runtimeId: 'runtime-1' }) };
const publicAgent = {
  id: 'runtime-agent-1',
  name: 'Hidden public runtime',
  workspaceId: 'workspace-1',
  servers: [{ deploymentId: 'deployment-1' }, { deploymentId: 'injected-deployment' }],
  skills: [],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
  runtime: {
    id: 'runtime-1',
    kind: 'hermes',
    sandbox: { config: { managedBy: 'agent-endpoint-runtime' } },
  },
  publicRuntimeAllocation: {
    id: 'allocation-1',
    revisionId: 'revision-1',
    revision: {
      systemPrompt: 'Public policy',
      deploymentIds: ['deployment-1'],
      toolPolicy: { 'deployment-1': ['read'] },
    },
  },
};

function request(method: string, params: Record<string, unknown> = {}) {
  return new Request('http://toolplane.test/api/v1/agent-runtimes/runtime-1/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer runtime-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('public Hermes runtime MCP policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeFindUnique.mockResolvedValue({
      id: 'runtime-1',
      kind: 'hermes',
      workspaceId: 'workspace-1',
      agentId: 'runtime-agent-1',
    });
    mocks.getAgent.mockResolvedValue(publicAgent);
    mocks.verifyToken.mockReturnValue(true);
    mocks.liveStatus.mockReturnValue('running');
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map([
      ['deployment-1', { mode: 'all', allowedTools: [], publicInvocable: true }],
      ['injected-deployment', { mode: 'all', allowedTools: [], publicInvocable: true }],
    ]));
    mocks.listMcpTools.mockResolvedValue([
      { name: 'read', description: 'Read data' },
      { name: 'write', description: 'Write data' },
    ]);
    mocks.mcpRpc.mockResolvedValue({ content: [{ type: 'text', text: 'secret result' }] });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it('intersects tools/list with both revision deployments and the revision tool allowlist', async () => {
    const response = await POST(request('tools/list'), context);

    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: [{ name: 'deployment-1__read', description: 'Read data' }],
      },
    });
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(1);
    expect(mocks.listMcpTools).toHaveBeenCalledWith('deployment-1', {
      signal: expect.any(AbortSignal),
      maxResponseBytes: 512 * 1024,
    });
  });

  it('rejects cached tool names outside the immutable public policy', async () => {
    const response = await POST(request('tools/call', {
      name: 'deployment-1__write',
      arguments: { value: 'sensitive input' },
    }), context);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32602, message: 'Unknown tool: deployment-1__write' },
    });
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });

  it('immediately removes a deployment when its public invocation approval is revoked', async () => {
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map([
      ['deployment-1', { mode: 'allowlist', allowedTools: ['read'], publicInvocable: false }],
      ['injected-deployment', { mode: 'all', allowedTools: [], publicInvocable: true }],
    ]));

    const response = await POST(request('tools/list'), context);

    await expect(response.json()).resolves.toMatchObject({ result: { tools: [] } });
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });

  it('never stores managed public tool arguments or results in request logs', async () => {
    const response = await POST(request('tools/call', {
      name: 'deployment-1__read',
      arguments: { query: 'private customer data' },
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.mcpRpc).toHaveBeenCalledWith('deployment-1', 'tools/call', {
      name: 'read',
      arguments: { query: 'private customer data' },
    }, 30_000, {
      signal: expect.any(AbortSignal),
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 512 * 1024,
    });
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: 'deployment-1',
      requestBody: null,
      responseBody: null,
    }));
  });

  it('preserves detailed MCP audit bodies for ordinary Hermes Agents', async () => {
    mocks.getAgent.mockResolvedValue({
      ...publicAgent,
      publicRuntimeAllocation: null,
      runtime: {
        ...publicAgent.runtime,
        sandbox: { config: { managedBy: 'agent-runtime' } },
      },
    });

    await POST(request('tools/call', {
      name: 'deployment-1__read',
      arguments: { query: 'ordinary audit' },
    }), context);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.stringContaining('ordinary audit'),
      responseBody: expect.stringContaining('secret result'),
    }));
  });

  it('fails closed when endpoint deletion leaves a marked runtime without its allocation', async () => {
    mocks.getAgent.mockResolvedValue({ ...publicAgent, publicRuntimeAllocation: null });

    const response = await POST(request('tools/list'), context);

    expect(response.status).toBe(404);
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });
});
