// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUser: vi.fn(),
  getTerminal: vi.fn(),
  ensureReady: vi.fn(),
  livePort: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveUser }));
vi.mock('@/lib/agents/queries', () => ({
  getHermesTerminalForRequest: mocks.getTerminal,
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesDashboardReady: mocks.ensureReady,
}));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));

import {
  DELETE,
  GET,
  POST,
} from '@/app/api/v1/agents/[agentId]/terminal/[[...path]]/route';

describe('Hermes Agent terminal API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUser.mockResolvedValue({ id: 'user-1' });
    mocks.getTerminal.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtime: { id: 'runtime-1', sandbox: { deploymentId: 'deployment-1' } },
    });
    mocks.livePort.mockReturnValue(4312);
    mocks.ensureReady.mockResolvedValue({ port: 4312 });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects unauthenticated requests before resolving an Agent', async () => {
    mocks.resolveUser.mockResolvedValue(null);
    const response = await POST(new Request('http://toolplane.test/terminal', {
      method: 'POST',
      body: '{}',
    }), { params: Promise.resolve({ agentId: 'agent-1' }) });

    expect(response.status).toBe(401);
    expect(mocks.getTerminal).not.toHaveBeenCalled();
  });

  it('creates a terminal only through the URL Agent runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"terminal-1"}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new Request('http://toolplane.test/terminal', {
      method: 'POST',
      headers: {
        authorization: 'Bearer user-token',
        cookie: 'mcp_session=user-session',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    }), { params: Promise.resolve({ agentId: 'agent-1' }) });

    expect(response.status).toBe(201);
    expect(mocks.getTerminal).toHaveBeenCalledWith('agent-1', 'user-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4312/terminal/session');
    expect(init.body).toBe('{"cols":100,"rows":30}');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('starts a stopped Hermes runtime before opening its terminal', async () => {
    mocks.livePort.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"id":"terminal-1"}', {
      status: 201,
    })));

    const response = await POST(new Request('http://toolplane.test/terminal', {
      method: 'POST',
      body: '{}',
    }), { params: Promise.resolve({ agentId: 'agent-1' }) });

    expect(response.status).toBe(201);
    expect(mocks.ensureReady).toHaveBeenCalledWith('workspace-1', 'agent-1');
  });

  it('streams terminal events and closes only a validated session id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'event: ready\ndata: {}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));

    const stream = await GET(new Request('http://toolplane.test/terminal/terminal-1/stream'), {
      params: Promise.resolve({ agentId: 'agent-1', path: ['terminal-1', 'stream'] }),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const invalid = await DELETE(new Request('http://toolplane.test/terminal/not_valid', {
      method: 'DELETE',
    }), {
      params: Promise.resolve({ agentId: 'agent-1', path: ['not_valid'] }),
    });
    expect(invalid.status).toBe(404);
  });
});
