// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockAgentControlError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AgentControlError: MockAgentControlError,
    resolveAgentControlRequestUser: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    logRequest: vi.fn(),
    listResources: vi.fn(),
    inspectDeployment: vi.fn(),
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    createAgent: vi.fn(),
    sendMessage: vi.fn(),
  };
});

vi.mock('@/lib/auth/request-user', () => ({
  resolveAgentControlRequestUser: mocks.resolveAgentControlRequestUser,
}));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));
vi.mock('@/lib/agents/control-service', () => ({
  AgentControlError: mocks.AgentControlError,
  listAgentControlResources: mocks.listResources,
  inspectAgentControlDeployment: mocks.inspectDeployment,
  listAgentControlAgents: mocks.listAgents,
  getAgentControlAgent: mocks.getAgent,
  createAgentFromControl: mocks.createAgent,
  sendAgentControlMessage: mocks.sendMessage,
}));

import { AgentControlError } from '@/lib/agents/control-service';
import { POST } from '@/app/api/v1/workspaces/[slug]/agents/mcp/route';

function request(method: string, params?: Record<string, unknown>, id: unknown = 1) {
  return new Request('http://localhost/api/v1/workspaces/acme/agents/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function call(name: string, args: Record<string, unknown> = {}) {
  return request('tools/call', { name, arguments: args });
}

const routeParams = { params: Promise.resolve({ slug: 'acme' }) };

describe('Agent Control MCP protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentControlRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme', name: 'Acme' });
    mocks.logRequest.mockResolvedValue(undefined);
    mocks.listResources.mockResolvedValue({ providers: [] });
    mocks.createAgent.mockResolvedValue({ created: true, agent: { id: 'agent-1' } });
  });

  it('initializes as a stateless MCP tool server', async () => {
    const response = await POST(request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }), routeParams);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ToolPlane Agent Control: Acme' },
      },
    });
  });

  it('advertises the resource discovery, creation, inspection, and messaging tools', async () => {
    const response = await POST(request('tools/list'), routeParams);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_agent_resources',
      'inspect_mcp_deployment',
      'list_agents',
      'get_agent',
      'create_agent',
      'send_message_to_agent',
    ]);
    expect(body.result.tools.find((tool: { name: string }) => tool.name === 'create_agent'))
      .toMatchObject({ annotations: { idempotentHint: false, destructiveHint: false } });
    expect(body.result.tools.find((tool: { name: string }) => tool.name === 'send_message_to_agent'))
      .toMatchObject({ annotations: { idempotentHint: false, destructiveHint: true } });
  });

  it('requires and dispatches an explicit implemented runtime', async () => {
    const response = await POST(call('create_agent', {
      name: 'Researcher',
      runtime: 'pi',
      providerId: 'provider-1',
      model: 'gpt-test',
    }), routeParams);

    expect(mocks.createAgent).toHaveBeenCalledWith('workspace-1', 'acme', {
      name: 'Researcher',
      runtime: 'pi',
      systemPrompt: undefined,
      providerId: 'provider-1',
      providerIds: [],
      model: 'gpt-test',
      maxSteps: 100,
      deploymentIds: [],
      installedSkillIds: [],
      toolkitIds: [],
      sandboxIds: [],
      subAgentIds: [],
    });
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: { result: { created: true, agent: { id: 'agent-1' } } },
      },
    });
  });

  it('returns recoverable tool errors for invalid input and domain failures', async () => {
    const invalid = await POST(call('create_agent', { name: '', maxSteps: 1001 }), routeParams);
    const invalidBody = await invalid.json();
    expect(invalidBody.result.isError).toBe(true);
    expect(invalidBody.result.structuredContent.error.code).toBe('invalid_arguments');
    expect(mocks.createAgent).not.toHaveBeenCalled();

    const untrustedImage = await POST(call('create_agent', {
      name: 'Untrusted runtime',
      runtime: 'hermes',
      hermesImage: 'attacker.example/steal-secrets:latest',
    }), routeParams);
    const untrustedImageBody = await untrustedImage.json();
    expect(untrustedImageBody.result.isError).toBe(true);
    expect(untrustedImageBody.result.structuredContent.error.code).toBe('invalid_arguments');
    expect(mocks.createAgent).not.toHaveBeenCalled();

    mocks.getAgent.mockRejectedValue(new AgentControlError('not_found', 'Agent not found.'));
    const missing = await POST(call('get_agent', { agentId: 'missing' }), routeParams);
    await expect(missing.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'not_found', message: 'Agent not found.' } },
      },
    });
    expect(mocks.logRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      statusCode: 404,
    }));
  });

  it('rejects unknown tools, malformed JSON-RPC, and batch requests', async () => {
    const unknown = await POST(call('delete_agent'), routeParams);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: -32602 } });

    const malformed = await POST(new Request('http://localhost', {
      method: 'POST',
      body: '{',
    }), routeParams);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32700 } });

    const batch = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    }), routeParams);
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it('validates initialization, request envelopes, and protocol version headers', async () => {
    const missingInitializeParams = await POST(request('initialize'), routeParams);
    await expect(missingInitializeParams.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });

    const invalidId = await POST(request('tools/list', undefined, null), routeParams);
    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const invalidParams = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [] }),
    }), routeParams);
    expect(invalidParams.status).toBe(400);
    await expect(invalidParams.json()).resolves.toMatchObject({ error: { code: -32602 } });

    const unsupportedVersion = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '1999-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), routeParams);
    expect(unsupportedVersion.status).toBe(400);
    await expect(unsupportedVersion.json()).resolves.toMatchObject({ error: { code: -32006 } });
  });

  it('does not execute id-less tool notifications', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'create_agent',
          arguments: { name: 'Blind write' },
        },
      }),
    }), routeParams);
    expect(response.status).toBe(202);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it('enforces authentication and hides inaccessible workspaces', async () => {
    mocks.resolveAgentControlRequestUser.mockResolvedValueOnce(null);
    const unauthorized = await POST(request('tools/list'), routeParams);
    expect(unauthorized.status).toBe(401);

    mocks.getWorkspaceForUser.mockResolvedValueOnce(null);
    const missing = await POST(request('tools/list'), routeParams);
    expect(missing.status).toBe(404);
  });

  it('rejects a browser-supplied cross-origin request before authentication', async () => {
    const crossOrigin = new Request('http://localhost/api/v1/workspaces/acme/agents/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const response = await POST(crossOrigin, routeParams);
    expect(response.status).toBe(403);
    expect(mocks.resolveAgentControlRequestUser).not.toHaveBeenCalled();
  });

  it('rejects an oversized request before authentication', async () => {
    const oversized = new Request('http://localhost/api/v1/workspaces/acme/agents/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(256 * 1024 + 1),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const response = await POST(oversized, routeParams);
    expect(response.status).toBe(413);
    expect(mocks.resolveAgentControlRequestUser).not.toHaveBeenCalled();
  });
});
