// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  modelProviderFindFirst: vi.fn(),
  deploymentFindFirst: vi.fn(),
  livePort: vi.fn(),
  logRequest: vi.fn(),
  fetch: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleAnthropicCountTokens: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    agent: { findFirst: mocks.agentFindFirst },
    modelProvider: { findFirst: mocks.modelProviderFindFirst },
    deployment: { findFirst: mocks.deploymentFindFirst },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));
vi.mock('@/lib/agents/anthropic-gateway', () => ({
  handleAnthropicMessages: mocks.handleAnthropicMessages,
  handleAnthropicCountTokens: mocks.handleAnthropicCountTokens,
}));

import { createAgentRuntimeToken } from '@/lib/agents/runtime-access';
import { POST as proxyModel } from '@/app/api/v1/agent-runtime/model/[providerId]/[[...path]]/route';
import { POST as proxyMcp } from '@/app/api/v1/agent-runtime/mcp/[deploymentId]/rpc/route';

describe('Agent runtime proxy boundaries', () => {
  const originalSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = 'runtime-proxy-test-secret';
    mocks.agentFindFirst.mockResolvedValue({
      runtimeKind: 'pi',
      servers: [{ deploymentId: 'deployment-1' }],
      toolkits: [],
      sandboxes: [{
        sandboxId: 'sandbox-1',
        sandbox: { workspaceId: 'workspace-1', kind: 'docker', network: 'isolated' },
      }],
    });
    mocks.livePort.mockReturnValue(4312);
    mocks.logRequest.mockResolvedValue(undefined);
    mocks.handleAnthropicMessages.mockResolvedValue(new Response('anthropic gateway'));
    mocks.handleAnthropicCountTokens.mockResolvedValue(Response.json({ input_tokens: 12 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
    vi.unstubAllGlobals();
  });

  async function token() {
    return createAgentRuntimeToken({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-1',
      providerId: 'provider-1',
      deploymentIds: ['deployment-1'],
      exp: Math.floor(Date.now() / 1000) + 300,
    });
  }

  it('rejects a provider outside the signed grant before querying it', async () => {
    const response = await proxyModel(new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-2/chat/completions',
      { method: 'POST', headers: { authorization: `Bearer ${await token()}` }, body: '{}' },
    ), { params: Promise.resolve({ providerId: 'provider-2', path: ['chat', 'completions'] }) });

    expect(response.status).toBe(403);
    expect(mocks.modelProviderFindFirst).not.toHaveBeenCalled();
  });

  it('injects the workspace provider key and streams the upstream response', async () => {
    mocks.modelProviderFindFirst.mockResolvedValue({
      format: 'openai',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'real-provider-key',
    });
    let sentHeaders = new Headers();
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      sentHeaders = new Headers(init.headers);
      return new Response('data: chunk\n\n', {
        headers: { 'content-type': 'text/event-stream', 'set-cookie': 'provider=x' },
      });
    });

    const response = await proxyModel(new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-1/chat/completions?stream=true',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          cookie: 'runtime=session',
          'content-type': 'application/json',
          'x-api-key': 'container-supplied-key',
        },
        body: '{"stream":true}',
      },
    ), { params: Promise.resolve({ providerId: 'provider-1', path: ['chat', 'completions'] }) });

    expect(mocks.modelProviderFindFirst).toHaveBeenCalledWith({
      where: { id: 'provider-1', workspaceId: 'workspace-1' },
      select: { name: true, format: true, baseUrl: true, apiKey: true },
    });
    expect(mocks.agentFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'agent-1',
        workspaceId: 'workspace-1',
        OR: [
          { providerId: 'provider-1' },
          { modelProviders: { some: { providerId: 'provider-1' } } },
        ],
      },
      select: {
        runtimeKind: true,
        servers: { select: { deploymentId: true } },
        toolkits: {
          select: { toolkit: { select: { servers: { select: { deploymentId: true } } } } },
        },
        sandboxes: {
          select: {
            sandboxId: true,
            sandbox: { select: { workspaceId: true, kind: true, network: true } },
          },
        },
      },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://provider.test/v1/chat/completions?stream=true',
      expect.any(Object),
    );
    expect(sentHeaders.get('authorization')).toBe('Bearer real-provider-key');
    expect(sentHeaders.get('x-api-key')).toBeNull();
    expect(sentHeaders.get('cookie')).toBeNull();
    expect(response.body).not.toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.text()).resolves.toBe('data: chunk\n\n');
  });

  it('routes Claude Messages and count_tokens through the compatibility gateway', async () => {
    const configuredProvider = {
      name: 'Responses',
      format: 'openai-responses',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'real-provider-key',
    };
    mocks.modelProviderFindFirst.mockResolvedValue(configuredProvider);

    const messagesRequest = new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-1/v1/messages',
      { method: 'POST', headers: { authorization: `Bearer ${await token()}` }, body: '{}' },
    );
    const messages = await proxyModel(messagesRequest, {
      params: Promise.resolve({ providerId: 'provider-1', path: ['v1', 'messages'] }),
    });
    expect(await messages.text()).toBe('anthropic gateway');
    expect(mocks.handleAnthropicMessages).toHaveBeenCalledWith(messagesRequest, {
      id: 'provider-1',
      ...configuredProvider,
    });

    const countRequest = new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-1/v1/messages/count_tokens',
      { method: 'POST', headers: { authorization: `Bearer ${await token()}` }, body: '{}' },
    );
    await proxyModel(countRequest, {
      params: Promise.resolve({ providerId: 'provider-1', path: ['v1', 'messages', 'count_tokens'] }),
    });
    expect(mocks.handleAnthropicCountTokens).toHaveBeenCalledWith(countRequest);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps Anthropic providers on the native pass-through path', async () => {
    mocks.modelProviderFindFirst.mockResolvedValue({
      name: 'Anthropic',
      format: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
    });
    mocks.fetch.mockResolvedValue(Response.json({ type: 'message' }));

    await proxyModel(new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-1/v1/messages',
      { method: 'POST', headers: { authorization: `Bearer ${await token()}` }, body: '{}' },
    ), { params: Promise.resolve({ providerId: 'provider-1', path: ['v1', 'messages'] }) });

    expect(mocks.fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.any(Object));
    expect(mocks.handleAnthropicMessages).not.toHaveBeenCalled();
  });

  it('rejects an MCP deployment outside the signed grant', async () => {
    const response = await proxyMcp(new Request(
      'http://toolplane.test/api/v1/agent-runtime/mcp/deployment-2/rpc',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}` },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    ), { params: Promise.resolve({ deploymentId: 'deployment-2' }) });

    expect(response.status).toBe(403);
    expect(mocks.deploymentFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a token after its Agent, provider, or docker sandbox binding is removed', async () => {
    mocks.agentFindFirst.mockResolvedValue(null);
    const response = await proxyModel(new Request(
      'http://toolplane.test/api/v1/agent-runtime/model/provider-1/chat/completions',
      { method: 'POST', headers: { authorization: `Bearer ${await token()}` }, body: '{}' },
    ), { params: Promise.resolve({ providerId: 'provider-1', path: ['chat', 'completions'] }) });

    expect(response.status).toBe(403);
    expect(mocks.modelProviderFindFirst).not.toHaveBeenCalled();
  });

  it('scopes an allowed MCP deployment to the workspace and keeps its tool policy', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'deployment-1',
      workspaceId: 'workspace-1',
      mcpToolExposure: 'allowlist',
      mcpAllowedTools: ['read'],
    });
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'read' }, { name: 'write' }] },
    })));

    const response = await proxyMcp(new Request(
      'http://toolplane.test/api/v1/agent-runtime/mcp/deployment-1/rpc',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}` },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    ), { params: Promise.resolve({ deploymentId: 'deployment-1' }) });

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'deployment-1', workspaceId: 'workspace-1' },
    }));
    expect(mocks.agentFindFirst).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ result: { tools: [{ name: 'read' }] } });
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      deploymentId: 'deployment-1',
    }));
  });
});
