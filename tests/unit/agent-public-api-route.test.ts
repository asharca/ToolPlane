// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePrincipal: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  getResponse: vi.fn(),
}));

vi.mock('@/lib/agents/public-api/auth', () => ({
  resolveAgentApiPrincipal: mocks.resolvePrincipal,
}));
vi.mock('@/lib/agents/public-api/http', () => ({
  agentApiHeaders: vi.fn(async () => new Headers({ vary: 'Origin' })),
  agentApiPreflight: vi.fn(async () => new Response(null, { status: 204 })),
  mergeHeaders: (...sources: HeadersInit[]) => {
    const headers = new Headers();
    for (const source of sources) new Headers(source).forEach((value, key) => headers.set(key, value));
    return headers;
  },
  agentApiJson: (body: unknown, init: { status?: number; headers?: HeadersInit } = {}) => new Response(
    JSON.stringify(body),
    { status: init.status ?? 200, headers: { ...Object.fromEntries(new Headers(init.headers)), 'content-type': 'application/json' } },
  ),
}));
vi.mock('@/lib/agents/public-api/ids', () => ({ createAgentRequestId: () => 'req_provisional' }));
vi.mock('@/lib/agents/public-api/rate-limit', () => ({
  takeAgentApiPrincipalRateLimit: vi.fn(async () => ({
    limit: 10,
    remaining: 9,
    reset: 1,
    headers: new Headers({ 'ratelimit-remaining': '9' }),
  })),
}));
vi.mock('@/lib/agents/public-api/runs', () => ({
  prepareAgentResponse: mocks.prepare,
  executePreparedAgentResponse: mocks.execute,
  getAgentResponseForPrincipal: mocks.getResponse,
}));

import { AgentApiError } from '@/lib/agents/public-api/errors';
import { POST } from '@/app/api/v1/agent-endpoints/[endpointId]/responses/route';

const principal = {
  credentialType: 'api_key',
  endpointId: 'endpoint-1',
  endpointPublicId: 'agep_test',
  workspaceId: 'workspace-1',
  sourceAgentId: 'agent-1',
  revisionId: 'revision-1',
  clientId: 'client-1',
  keyId: 'key-1',
  subjectHash: null,
  origin: null,
  scopes: ['responses:create'],
  limits: { rpm: 10, dailyRequests: 100, maxConcurrent: 2, timeoutSeconds: 60, retentionDays: 30 },
  rateBuckets: { endpointRpm: 10, clientRpm: 10, endpointDaily: 100, clientDaily: 100 },
};
const prepared = {
  runId: 'run-1',
  responseId: 'resp_test',
  requestId: 'req_test',
  endpointId: 'endpoint-1',
  endpointPublicId: 'agep_test',
  endpointRevision: 2,
  clientId: 'client-1',
  subjectHash: 'subject-hash',
  publicConversationId: 'cnv_test',
  input: 'hello',
  stream: false,
  timeoutSeconds: 60,
  replay: false,
  rateLimitHeaders: new Headers({ 'ratelimit-remaining': '9' }),
};
const view = {
  id: 'resp_test',
  object: 'agent.response',
  created_at: 1,
  endpoint_id: 'agep_test',
  endpoint_revision: 2,
  conversation_id: 'cnv_test',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
  output_text: 'answer',
  usage: { input_characters: 5, output_characters: 6, duration_ms: 10 },
  request_id: 'req_test',
};

function request(body: unknown) {
  return new Request('https://toolplane.test/api/v1/agent-endpoints/agep_test/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer tp_agent_test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ endpointId: 'agep_test' }) };

describe('Agent Responses public route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrincipal.mockResolvedValue(principal);
    mocks.prepare.mockResolvedValue(prepared);
    mocks.execute.mockResolvedValue(view);
    mocks.getResponse.mockResolvedValue(view);
  });

  it('returns a stable 401 error envelope when the scoped Bearer credential is invalid', async () => {
    mocks.resolvePrincipal.mockResolvedValue(null);
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: false }), context);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_api_key', request_id: 'req_provisional' },
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rejects caller-owned system prompts and tools through the strict schema', async () => {
    const response = await POST(request({
      input: 'hello', end_user: 'u', system: 'override', tools: [], stream: false,
    }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('returns a completed non-stream response with request, conversation and rate headers', async () => {
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: false }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_test');
    expect(response.headers.get('x-toolplane-conversation-id')).toBe('cnv_test');
    expect(response.headers.get('ratelimit-remaining')).toBe('9');
    await expect(response.json()).resolves.toEqual(view);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('emits only the versioned public text lifecycle over SSE', async () => {
    mocks.prepare.mockResolvedValue({ ...prepared, stream: true });
    mocks.execute.mockImplementation(async (_prepared, options) => {
      await options.onDelta('safe delta');
      return view;
    });
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: true }), context);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('safe delta');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('tool_arguments');
  });

  it('sanitizes an upstream failure without exposing its raw detail', async () => {
    mocks.execute.mockRejectedValue(new AgentApiError('upstream_error', 'The Agent could not complete this response.', 502));
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: false }), context);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('upstream_error');
    expect(body).not.toContain('provider-secret');
  });

  it('replays a completed idempotent response without starting Hermes again', async () => {
    mocks.prepare.mockResolvedValue({ ...prepared, replay: true });
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: false }), context);
    expect(response.status).toBe(200);
    expect(mocks.getResponse).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('preserves the original stable error and status when replaying a failed response', async () => {
    mocks.prepare.mockResolvedValue({ ...prepared, replay: true });
    mocks.getResponse.mockResolvedValue({
      ...view,
      status: 'failed',
      output_text: '',
      error: { code: 'request_timeout', message: 'The Agent response timed out.' },
    });
    const response = await POST(request({ input: 'hello', end_user: 'u', stream: false }), context);
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'request_timeout', request_id: 'req_test' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
