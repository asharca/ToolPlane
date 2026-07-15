// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  toolkitFindFirst: vi.fn(),
  liveStatus: vi.fn(),
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
  logRequest: vi.fn(),
  loadMcpToolPolicies: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/db', () => ({ db: { toolkit: { findFirst: mocks.toolkitFindFirst } } }));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: mocks.liveStatus }));
vi.mock('@/lib/process/mcp-client', () => ({
  listMcpTools: mocks.listMcpTools,
  mcpRpc: mocks.mcpRpc,
}));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));
vi.mock('@/lib/workspace/mcp-tool-exposure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/mcp-tool-exposure')>();
  return { ...actual, loadMcpToolPolicies: mocks.loadMcpToolPolicies };
});

import { POST } from '@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route';

function request(method: string, params: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/v1/workspaces/acme/toolkits/default/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const routeParams = {
  params: Promise.resolve({ slug: 'acme', toolkitSlug: 'default' }),
};

describe('toolkit MCP tool exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user1' });
    mocks.toolkitFindFirst.mockResolvedValue({
      name: 'Default',
      workspaceId: 'ws1',
      servers: [{ deploymentId: 'dep1' }],
    });
    mocks.liveStatus.mockReturnValue('running');
    mocks.listMcpTools.mockResolvedValue([{ name: 'read' }, { name: 'write' }]);
    mocks.mcpRpc.mockResolvedValue({ content: [] });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it.each([
    ['all', [] as string[], ['dep1__read', 'dep1__write']],
    ['allowlist', ['read'], ['dep1__read']],
    ['allowlist', [], []],
  ] as const)('applies %s policy to tools/list', async (mode, allowedTools, expected) => {
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map([
      ['dep1', { mode, allowedTools }],
    ]));

    const response = await POST(request('tools/list'), routeParams);
    const payload = await response.json();

    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expected);
  });

  it('rejects direct calls to hidden tools without invoking the MCP', async () => {
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map([
      ['dep1', { mode: 'allowlist', allowedTools: ['read'] }],
    ]));

    const response = await POST(request('tools/call', {
      name: 'dep1__write',
      arguments: {},
    }), routeParams);

    await expect(response.json()).resolves.toMatchObject({ error: { code: -32602 } });
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });

  it('does not inspect a deployment missing from the workspace-scoped policy map', async () => {
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map());

    const response = await POST(request('tools/list'), routeParams);

    await expect(response.json()).resolves.toMatchObject({ result: { tools: [] } });
    expect(mocks.liveStatus).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });
});
