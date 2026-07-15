// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  livePort: vi.fn(),
  logRequest: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/db', () => ({
  db: { deployment: { findFirst: mocks.deploymentFindFirst } },
}));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));

import { POST } from '@/app/api/v1/mcp/[deploymentId]/rpc/route';

function request(method: string, params?: Record<string, unknown>) {
  return new Request('http://localhost/api/v1/mcp/dep1/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function batchRequest(method: string) {
  return new Request('http://localhost/api/v1/mcp/dep1/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method, params: { name: 'write' } }]),
  });
}

describe('direct MCP gateway tool exposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user1' });
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      status: 'running',
      mcpToolExposure: 'allowlist',
      mcpAllowedTools: ['read'],
    });
    mocks.livePort.mockReturnValue(4321);
    mocks.logRequest.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('filters tools/list to the allowlist', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'read' }, { name: 'write' }] },
    })));

    const response = await POST(request('tools/list'), {
      params: Promise.resolve({ deploymentId: 'dep1' }),
    });

    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [{ name: 'read' }] },
    });
  });

  it('rejects a hidden tools/call without contacting the MCP process', async () => {
    const response = await POST(request('tools/call', {
      name: 'write',
      arguments: {},
    }), { params: Promise.resolve({ deploymentId: 'dep1' }) });

    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32602, message: 'Unknown tool: write' },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['tools/list', 'tools/call'])('rejects batch %s requests before they can bypass policy', async (method) => {
    const response = await POST(batchRequest(method), {
      params: Promise.resolve({ deploymentId: 'dep1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32600 },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
