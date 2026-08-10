// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvePrincipal: vi.fn(),
  rateLimit: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  getResponse: vi.fn(),
}));

vi.mock('@/lib/agents/public-api/auth', () => ({
  resolveAgentApiPrincipalForAnyEndpoint: mocks.resolvePrincipal,
}));
vi.mock('@/lib/agents/public-api/http', () => ({
  agentApiHeaders: vi.fn(async () => new Headers()),
  mergeHeaders: (...sources: HeadersInit[]) => {
    const headers = new Headers();
    for (const source of sources) new Headers(source).forEach((value, key) => headers.set(key, value));
    return headers;
  },
  agentApiJson: (body: unknown, init: { status?: number; headers?: HeadersInit } = {}) => new Response(
    JSON.stringify(body),
    {
      status: init.status ?? 200,
      headers: { ...Object.fromEntries(new Headers(init.headers)), 'content-type': 'application/json' },
    },
  ),
}));
vi.mock('@/lib/agents/public-api/ids', () => ({ createAgentRequestId: () => 'req_provisional' }));
vi.mock('@/lib/agents/public-api/rate-limit', () => ({
  takeAgentApiPrincipalRateLimit: mocks.rateLimit,
}));
vi.mock('@/lib/agents/public-api/runs', () => ({
  prepareAgentResponse: mocks.prepare,
  executePreparedAgentResponse: mocks.execute,
  getAgentResponseForPrincipal: mocks.getResponse,
}));

import { POST } from '@/app/api/openai/v1/chat/completions/route';

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
  requestId: 'req_durable',
  endpointId: 'endpoint-1',
  endpointPublicId: 'agep_test',
  endpointRevision: 1,
  clientId: 'client-1',
  subjectHash: 'subject-hash',
  publicConversationId: 'cnv_test',
  input: 'User: hello',
  stream: false,
  timeoutSeconds: 60,
  replay: false,
  rateLimitHeaders: new Headers(),
};
const view = {
  id: 'resp_test',
  object: 'agent.response',
  created_at: 1,
  endpoint_id: 'agep_test',
  endpoint_revision: 1,
  conversation_id: 'cnv_test',
  status: 'completed',
  output: [],
  output_text: 'hello',
  usage: { input_characters: 5, output_characters: 5, duration_ms: 10 },
  request_id: 'req_durable',
};

function request(body: BodyInit) {
  return new Request('https://toolplane.test/api/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer tp_agent_test', 'content-type': 'application/json' },
    body,
  });
}

describe('OpenAI-compatible Agent route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrincipal.mockResolvedValue(principal);
    mocks.rateLimit.mockResolvedValue({
      limit: 10,
      remaining: 9,
      reset: 1,
      headers: new Headers({ 'ratelimit-remaining': '9' }),
    });
    mocks.prepare.mockResolvedValue(prepared);
    mocks.execute.mockResolvedValue(view);
    mocks.getResponse.mockResolvedValue(view);
  });

  it('authenticates and consumes the operation quota before parsing invalid JSON', async () => {
    const response = await POST(request('{'));
    expect(response.status).toBe(400);
    expect(mocks.resolvePrincipal).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledWith(principal);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rejects a model that is not the Endpoint bound to the credential', async () => {
    const response = await POST(request(JSON.stringify({
      model: 'agep_other',
      user: 'customer-1',
      messages: [{ role: 'user', content: 'hello' }],
    })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('returns durable response identifiers on a completed request', async () => {
    const response = await POST(request(JSON.stringify({
      model: 'agep_test',
      user: 'customer-1',
      messages: [{ role: 'user', content: 'hello' }],
    })));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_durable');
    expect(response.headers.get('x-toolplane-response-id')).toBe('resp_test');
    await expect(response.json()).resolves.toMatchObject({
      id: 'chatcmpl_test',
      choices: [{ finish_reason: 'stop' }],
      toolplane_response_id: 'resp_test',
    });
  });

  it('returns a conflict instead of presenting an active replay as completed', async () => {
    mocks.prepare.mockResolvedValue({ ...prepared, replay: true });
    mocks.getResponse.mockResolvedValue({ ...view, status: 'running', output_text: '' });
    const response = await POST(request(JSON.stringify({
      model: 'agep_test',
      user: 'customer-1',
      messages: [{ role: 'user', content: 'hello' }],
    })));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'idempotency_conflict', request_id: 'req_durable' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('preserves the original runtime error when replaying a failed completion', async () => {
    mocks.prepare.mockResolvedValue({ ...prepared, replay: true });
    mocks.getResponse.mockResolvedValue({
      ...view,
      status: 'failed',
      output_text: '',
      error: { code: 'runtime_unavailable', message: 'The Agent runtime is temporarily unavailable.' },
    });
    const response = await POST(request(JSON.stringify({
      model: 'agep_test',
      user: 'customer-1',
      messages: [{ role: 'user', content: 'hello' }],
    })));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'runtime_unavailable', request_id: 'req_durable' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
