// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), rate: vi.fn(), prepare: vi.fn(), execute: vi.fn(),
  get: vi.fn(), cancel: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/agents/public-api/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/agents/public-api/auth')>(),
  resolveAgentApiPrincipal: mocks.resolve,
}));
vi.mock('@/lib/agents/public-api/rate-limit', () => ({
  takeAgentApiPrincipalRateLimit: mocks.rate,
  takeAgentApiAuthAttemptLimit: vi.fn(), takeAgentApiAuthFailureLimit: vi.fn(),
}));
vi.mock('@/lib/agents/public-api/runs', () => ({
  prepareAgentResponse: mocks.prepare, executePreparedAgentResponse: mocks.execute,
  getAgentResponseForPrincipal: mocks.get, requestAgentResponseCancellation: mocks.cancel,
}));
import { handleAgentServiceMcp } from '@/lib/agents/public-api/service-mcp';
import { AgentApiError } from '@/lib/agents/public-api/errors';
import type { AgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { getLogContext } from '@/lib/observability/context';

const principal: AgentApiPrincipal = {
  credentialType: 'api_key', endpointId: 'endpoint-1', endpointPublicId: 'agep_test',
  workspaceId: 'workspace-1', sourceAgentId: 'private-agent-1', revisionId: 'revision-1',
  clientId: 'client-1', keyId: 'key-1', subjectHash: null, origin: null,
  scopes: ['responses:create', 'responses:read'],
  limits: { rpm: 20, dailyRequests: 100, maxConcurrent: 2, timeoutSeconds: 60, retentionDays: 7 },
  rateBuckets: { endpointRpm: 20, clientRpm: 20, endpointDaily: 100, clientDaily: 100 },
};
const prepared = {
  runId: 'private-run-1', responseId: 'resp_test', requestId: 'req_test',
  endpointId: 'endpoint-1', endpointPublicId: 'agep_test', endpointRevision: 2,
  clientId: 'client-1', subjectHash: 'subject-1', publicConversationId: 'cnv_test',
  input: 'Review this patch', stream: false, timeoutSeconds: 60, replay: false,
  rateLimitHeaders: new Headers(),
};
const view = {
  id: 'resp_test', object: 'agent.response', created_at: 1, endpoint_id: 'agep_test',
  endpoint_revision: 2, conversation_id: 'cnv_test', status: 'completed',
  output: [], output_text: 'Reviewed', request_id: 'req_test',
  usage: { input_characters: 17, output_characters: 8, duration_ms: 10 },
};
const invoke = { input: 'Review this patch', end_user: 'user-1', idempotency_key: 'review-001' };
const initialize = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } };
function request(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://toolplane.test/api/v1/agent-endpoints/agep_test/mcp', {
    method: 'POST', headers: { authorization: 'Bearer tp_agent_fixture_long_secret',
      'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body), signal,
  });
}
function rpc(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}
async function call(name: string, args: unknown = {}, headers: Record<string, string> = {}) {
  const response = await handleAgentServiceMcp(request(rpc('tools/call', { name, arguments: args }), headers), 'agep_test');
  return { response, body: await response.json() };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(principal);
  mocks.rate.mockResolvedValue({ headers: new Headers({ 'ratelimit-remaining': '9' }) });
  mocks.prepare.mockResolvedValue(prepared);
  mocks.execute.mockResolvedValue(view);
  mocks.get.mockResolvedValue(view);
  mocks.cancel.mockResolvedValue({ ...view, cancellation_requested: false });
});

describe('published Agent service MCP boundary', () => {
  it('authenticates before parsing or revealing tools', async () => {
    mocks.resolve.mockResolvedValue(null);
    const response = await handleAgentServiceMcp(request(rpc('tools/list')), 'agep_test');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('invoke_agent');
  });

  it.each(['https://evil.test', 'null', ''])('rejects browser Origin %j before credential lookup', async (origin) => {
    const response = await handleAgentServiceMcp(request(rpc('initialize', initialize), { origin }), 'agep_test');
    expect(response.status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['GET', 'DELETE', 'OPTIONS'])('does not create sessions or streams for %s', async (method) => {
    const response = await handleAgentServiceMcp(new Request('https://toolplane.test/mcp', { method }), 'agep_test');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['2025-03-26', '2025-06-18', 'future-client-version'])('negotiates %s without claiming Tasks or A2A', async (protocolVersion) => {
    const response = await handleAgentServiceMcp(request(rpc('initialize', { ...initialize, protocolVersion })), 'agep_test');
    const body = await response.json();
    expect(body.result.protocolVersion).toBe(protocolVersion === '2025-03-26' ? protocolVersion : '2025-06-18');
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('filters discovery by scopes and excludes management tools and private ids', async () => {
    mocks.resolve.mockResolvedValue({ ...principal, scopes: ['responses:read'] });
    const response = await handleAgentServiceMcp(request(rpc('tools/list')), 'agep_test');
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_agent_response']);
    expect(JSON.stringify(body)).not.toContain('private-agent-1');
    expect(body.result.tools[0]).not.toHaveProperty('scopes');
  });

  it('requires both create and read for cancellation even when the name is guessed', async () => {
    mocks.resolve.mockResolvedValue({ ...principal, scopes: ['responses:create'] });
    const { body } = await call('cancel_agent_response', { response_id: 'resp_other' });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('insufficient_scope');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does not execute a tool-call notification', async () => {
    const response = await handleAgentServiceMcp(request({ jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'invoke_agent', arguments: invoke } }), 'agep_test');
    expect(response.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('acknowledges initialized notifications with no body', async () => {
    const response = await handleAgentServiceMcp(request({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'agep_test');
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(['2024-11-05', 'unsupported'])('rejects unsupported protocol header %s', async (version) => {
    const response = await handleAgentServiceMcp(request(rpc('ping'), { 'mcp-protocol-version': version }), 'agep_test');
    expect(response.status).toBe(400);
  });

  it.each(['application/json', 'text/event-stream', 'application/json;q=0, text/event-stream'])('rejects incompatible Accept %s', async (accept) => {
    const response = await handleAgentServiceMcp(request(rpc('ping'), { accept }), 'agep_test');
    expect(response.status).toBe(406);
  });

  it('bounds the body independently of Content-Length', async () => {
    const response = await handleAgentServiceMcp(request({ payload: 'x'.repeat(256 * 1024) }), 'agep_test');
    expect(response.status).toBe(413);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rejects JSON-RPC batches', async () => {
    const response = await handleAgentServiceMcp(request([rpc('ping')]), 'agep_test');
    expect(response.status).toBe(400);
  });

  it.each(['create_agent', 'list_agent_resources', 'get_agent'])('does not expose %s', async (name) => {
    const { body } = await call(name);
    expect(body.error.code).toBe(-32602);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('Agent service invocation and result ownership', () => {
  it('uses the verified principal, rate allowance, original signal and business idempotency key', async () => {
    const controller = new AbortController();
    const req = request(rpc('tools/call', { name: 'invoke_agent', arguments: { ...invoke, conversation_id: 'cnv_test' } }, 'rpc-unrelated'), {}, controller.signal);
    const response = await handleAgentServiceMcp(req, 'agep_test');
    const body = await response.json();
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      principal, input: invoke.input, endUser: 'user-1', conversationId: 'cnv_test',
      idempotencyKey: 'review-001', stream: false, signal: req.signal, rateLimit: expect.any(Object),
    }));
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith(prepared, { signal: req.signal });
    expect(body.id).toBe('rpc-unrelated');
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toEqual(view);
    expect(response.headers.get('x-toolplane-response-id')).toBe('resp_test');
    expect(JSON.stringify(body)).not.toContain('private-run-1');
  });

  it.each([
    { ...invoke, agentId: 'private-agent' }, { ...invoke, endpoint_id: 'agep_other' },
    { ...invoke, system: 'override' }, { ...invoke, tools: [] },
    { ...invoke, idempotency_key: undefined }, { ...invoke, input: 'x'.repeat(20_001) },
  ])('rejects identity/configuration overrides and invalid input %j', async (args) => {
    const { body } = await call('invoke_agent', args);
    expect(body.result.isError).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rejects accidental credential forwarding into the model input', async () => {
    const { body } = await call('invoke_agent', { ...invoke, input: 'my key is tp_agent_fixture_long_secret' });
    expect(body.result.isError).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('tp_agent_fixture_long_secret');
  });

  it.each(['completed', 'running', 'failed', 'cancelled'])('replays %s without re-executing the model', async (status) => {
    mocks.prepare.mockResolvedValue({ ...prepared, replay: true });
    mocks.get.mockResolvedValue({ ...view, status });
    const { body } = await call('invoke_agent', invoke);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith({ endpointPublicId: 'agep_test', responseId: 'resp_test', clientId: 'client-1', subjectHash: 'subject-1' });
    expect(JSON.parse(body.result.content[0].text).status).toBe(status);
    expect(body.result.isError).toBe(['failed', 'cancelled'].includes(status));
  });

  it('binds result access to client and verified subject, never to tool arguments', async () => {
    mocks.resolve.mockResolvedValue({ ...principal, credentialType: 'client_token', subjectHash: 'subject-bound' });
    await call('get_agent_response', { response_id: 'resp_other' });
    expect(mocks.get).toHaveBeenCalledWith({ endpointPublicId: 'agep_test', responseId: 'resp_other', clientId: 'client-1', subjectHash: 'subject-bound' });
  });

  it('does not reveal whether an inaccessible response exists', async () => {
    mocks.get.mockResolvedValue(null);
    const { body } = await call('get_agent_response', { response_id: 'resp_foreign' });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('not_found');
  });

  it('returns the actual cancellation result without inventing a stopped runtime', async () => {
    mocks.cancel.mockResolvedValue({ ...view, status: 'cancelled', cancellation_requested: true });
    const { body } = await call('cancel_agent_response', { response_id: 'resp_test' });
    expect(mocks.cancel).toHaveBeenCalledWith({ endpointPublicId: 'agep_test', responseId: 'resp_test', clientId: 'client-1', subjectHash: null });
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ status: 'cancelled', cancellation_requested: true });
  });

  it('suppresses payload collection throughout authentication and execution', async () => {
    mocks.execute.mockImplementation(async () => {
      expect(getLogContext()?.suppressPayload).toBe(true);
      return view;
    });
    await call('invoke_agent', invoke);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('returns a sanitized tool error, not a successful error string', async () => {
    mocks.execute.mockRejectedValue(new Error('provider secret PRIVATE_SECRET raw upstream'));
    const { body } = await call('invoke_agent', invoke);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).not.toContain('PRIVATE_SECRET');
  });

  it('preserves admission rate errors without starting an execution', async () => {
    mocks.rate.mockRejectedValue(new AgentApiError('rate_limit_exceeded', 'private detail', 429, 3));
    const { response, body } = await call('invoke_agent', invoke);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(JSON.stringify(body)).not.toContain('private detail');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('official MCP client interoperability', () => {
  it('initializes, lists and invokes through the repository SDK transport', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'toolplane-service-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('https://toolplane.test/mcp'), {
      requestInit: { headers: { authorization: 'Bearer tp_agent_fixture_long_secret' } },
      fetch: async (input, init) => handleAgentServiceMcp(new Request(input, init), 'agep_test'),
    });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(['invoke_agent', 'get_agent_response', 'cancel_agent_response']);
      const result = await client.callTool({ name: 'invoke_agent', arguments: invoke });
      expect(result.isError).toBe(false);
      expect(mocks.execute).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
});
