// @vitest-environment node
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const mocks = vi.hoisted(() => ({
  acquireWriteLease: vi.fn(),
  ensureReady: vi.fn(),
  findRuntime: vi.fn(),
  releaseWriteLease: vi.fn(),
  runMutation: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { agentRuntime: { findFirst: mocks.findRuntime } },
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: mocks.acquireWriteLease,
  ensureHermesDashboardReady: mocks.ensureReady,
  HERMES_RUNTIME_MAINTENANCE_IN_PROGRESS_ERROR: 'Hermes maintenance in progress.',
  runHermesDashboardMutation: mocks.runMutation,
}));
vi.mock('@/lib/agents/hermes/token', () => ({
  verifyHermesDashboardBrokerAccessToken: mocks.verifyToken,
}));

import {
  closeHermesDashboardBroker,
  ensureHermesDashboardBroker,
} from '@/lib/agents/hermes/dashboard-broker';

let brokerPort = 0;
let upstreamPort = 0;
let upstream: http.Server;
let upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let lastUpstreamRequest: {
  headers: http.IncomingHttpHeaders;
  method: string;
  url: string;
} | null = null;

function serveDashboardHtml(req: http.IncomingMessage, res: http.ServerResponse) {
  lastUpstreamRequest = {
    headers: req.headers,
    method: req.method || 'GET',
    url: req.url || '/',
  };
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    etag: 'upstream-html',
  });
  res.end([
    '<script>window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=true;</script>',
    '<script>localStorage.getItem("hermes-theme")</script>',
  ].join(''));
}

describe('Hermes dashboard separate-origin broker', () => {
  beforeAll(async () => {
    vi.stubEnv('HERMES_DASHBOARD_BIND', '127.0.0.1');
    vi.stubEnv('HERMES_DASHBOARD_PORT', '0');
    upstream = http.createServer((req, res) => upstreamHandler(req, res));
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        const address = upstream.address();
        if (address && typeof address === 'object') upstreamPort = address.port;
        resolve();
      });
    });
    brokerPort = (await ensureHermesDashboardBroker()).port;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lastUpstreamRequest = null;
    upstreamHandler = serveDashboardHtml;
    mocks.verifyToken.mockImplementation((_runtimeId: string, token: string) => (
      token === 'broker-token'
        ? { expiresAt: 2_000_000_000, parentOrigin: 'http://toolplane.test:3000' }
        : null
    ));
    mocks.findRuntime.mockResolvedValue({
      id: 'runtime-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-1',
      sandbox: { config: { managedBy: 'agent-runtime' } },
    });
    mocks.ensureReady.mockResolvedValue({ port: upstreamPort });
    mocks.acquireWriteLease.mockReturnValue({ release: mocks.releaseWriteLease });
    mocks.runMutation.mockImplementation(
      async (
        _workspaceId: string,
        _agentId: string,
        _lease: unknown,
        operation: (ready: { port?: number; error?: string }) => Promise<unknown>,
      ) => operation({ port: upstreamPort }),
    );
  });

  afterAll(async () => {
    await closeHermesDashboardBroker();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    vi.unstubAllEnvs();
  });

  it('rejects invalid broker capabilities before touching runtime state', async () => {
    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/invalid/`,
    );

    expect(response.status).toBe(401);
    expect(mocks.findRuntime).not.toHaveBeenCalled();
    expect(mocks.ensureReady).not.toHaveBeenCalled();
  });

  it('serves localStorage-capable HTML with an isolated CSP and stripped credentials', async () => {
    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/?theme=dark`,
      {
        headers: {
          authorization: 'Bearer toolplane-secret',
          cookie: 'mcp_session=secret',
          'x-hermes-session-token': 'hermes-session',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors http://toolplane.test:3000',
    );
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('etag')).toBeNull();
    const html = await response.text();
    expect(html).toContain('localStorage.getItem');
    expect(html).toContain('window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=true');
    expect(html).toContain('toolplane:close-agent-settings');

    expect(lastUpstreamRequest?.url).toBe('/hermes-dashboard/?theme=dark');
    expect(lastUpstreamRequest?.headers['x-forwarded-prefix']).toBe(
      '/agent-runtimes/runtime-1/dashboard/broker-token',
    );
    expect(lastUpstreamRequest?.headers['x-hermes-session-token']).toBe('hermes-session');
    expect(lastUpstreamRequest?.headers.authorization).toBeUndefined();
    expect(lastUpstreamRequest?.headers.cookie).toBeUndefined();
    expect(mocks.acquireWriteLease).not.toHaveBeenCalled();
    expect(mocks.runMutation).not.toHaveBeenCalled();
    expect(mocks.ensureReady).toHaveBeenCalledWith('workspace-1', 'agent-1');
  });

  it('serializes channel writes through the runtime lifecycle queue while preserving profile scope', async () => {
    upstreamHandler = (req, res) => {
      lastUpstreamRequest = {
        headers: req.headers,
        method: req.method || 'GET',
        url: req.url || '/',
      };
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, platform: 'telegram' }));
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/messaging/platforms/telegram?profile=research`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, platform: 'telegram' });
    expect(lastUpstreamRequest).toMatchObject({
      method: 'PUT',
      url: '/hermes-dashboard/api/messaging/platforms/telegram?profile=research',
    });
    expect(mocks.acquireWriteLease).toHaveBeenCalledWith('workspace-1', 'agent-1');
    expect(mocks.runMutation).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mocks.ensureReady).not.toHaveBeenCalled();
    expect(mocks.releaseWriteLease).toHaveBeenCalledOnce();
  });

  it('reloads the default multiplex gateway after a named-profile channel onboarding apply', async () => {
    const upstreamRequests: string[] = [];
    let statusReads = 0;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      upstreamRequests.push(`${req.method || 'GET'} ${url}`);
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        statusReads += 1;
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: statusReads === 1 ? 101 : 202,
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/messaging/telegram/onboarding/pair-1/apply?profile=research') {
        res.end(JSON.stringify({
          ok: true,
          platform: 'telegram',
          bot_username: 'saved_bot',
          needs_restart: false,
          restart_started: true,
          restart_pid: 6999,
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, pid: 7001 }));
        return;
      }
      if (url === '/hermes/health/detailed') {
        res.end(JSON.stringify({ gateway_state: 'running', pid: 202 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/messaging/telegram/onboarding/pair-1/apply?profile=research`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      platform: 'telegram',
      bot_username: 'saved_bot',
      needs_restart: false,
      restart_started: true,
      restart_pid: 7001,
      restart_ready: true,
      restart_action: 'gateway-restart',
    });
    expect(upstreamRequests).toEqual([
      'GET /hermes-dashboard/api/status',
      'POST /hermes-dashboard/api/messaging/telegram/onboarding/pair-1/apply?profile=research',
      'POST /hermes-dashboard/api/gateway/restart',
      'GET /hermes-dashboard/api/status',
      'GET /hermes/health/detailed',
    ]);
  });

  it('keeps a committed channel apply successful when its default restart fails verification', async () => {
    let statusReads = 0;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        statusReads += 1;
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: 101,
          gateway_updated_at: statusReads === 1 ? 'before' : 'after',
        }));
        return;
      }
      if (url.includes('/api/messaging/whatsapp/onboarding/pair-2/apply')) {
        res.end(JSON.stringify({
          ok: true,
          platform: 'whatsapp',
          needs_restart: false,
          restart_started: true,
          restart_pid: 7100,
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, pid: 7101 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        res.end(JSON.stringify({
          running: false,
          exit_code: 7,
          pid: 7101,
          lines: ['TOKEN=must-not-leak'],
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/messaging/whatsapp/onboarding/pair-2/apply?profile=research`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      platform: 'whatsapp',
      needs_restart: true,
      restart_started: false,
      restart_ready: false,
    });
    expect(String(payload.restart_error)).toContain('exit 7');
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
  });

  it('reserves the lifecycle queue before a slow dashboard request body finishes', async () => {
    upstreamHandler = (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: brokerPort,
        path: '/agent-runtimes/runtime-1/dashboard/broker-token/api/config',
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', reject);
      request.write('{"enabled":');
      void vi.waitFor(() => expect(mocks.runMutation).toHaveBeenCalledOnce()).then(() => {
        expect(lastUpstreamRequest).toBeNull();
        request.end('true}');
      }, reject);
    });

    await expect(response).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    expect(mocks.releaseWriteLease).toHaveBeenCalledOnce();
  });

  it('rejects a dashboard write before reading or proxying it during runtime maintenance', async () => {
    mocks.acquireWriteLease.mockReturnValue(null);

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/config`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Hermes maintenance in progress.' });
    expect(mocks.runMutation).not.toHaveBeenCalled();
    expect(lastUpstreamRequest).toBeNull();
  });

  it('normalizes a profile restart to the default gateway and returns only after its PID changes', async () => {
    const upstreamRequests: string[] = [];
    let restartStatusReads = 0;
    let statusReads = 0;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      upstreamRequests.push(`${req.method || 'GET'} ${url}`);
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        statusReads += 1;
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: statusReads <= 2 ? 101 : 202,
          gateway_updated_at: statusReads <= 2
            ? '2026-08-12T10:00:00Z'
            : '2026-08-12T10:00:01Z',
        }));
        return;
      }
      if (url === '/hermes/health/detailed') {
        res.end(JSON.stringify({ gateway_state: 'running', pid: 202 }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, name: 'gateway-restart', pid: 6001 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        restartStatusReads += 1;
        res.end(JSON.stringify({
          name: 'gateway-restart',
          running: false,
          exit_code: 0,
          // The action endpoint retains its previous result. The broker must
          // ignore that stale success and wait for the PID it just received.
          pid: restartStatusReads === 1 ? 5999 : 6001,
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'not found' }));
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart?profile=research`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: 'gateway-restart',
      pid: 6001,
      ready: true,
    });
    expect(upstreamRequests).toEqual([
      'GET /hermes-dashboard/api/status',
      'POST /hermes-dashboard/api/gateway/restart',
      'GET /hermes-dashboard/api/status',
      'GET /hermes-dashboard/api/actions/gateway-restart/status?lines=1',
      'GET /hermes-dashboard/api/status',
      'GET /hermes/health/detailed',
    ]);
    expect(upstreamRequests.some((entry) => entry.includes('profile=research'))).toBe(false);
  });

  it('does not accept a new Dashboard PID until the real API port reports the same owner', async () => {
    let statusReads = 0;
    let healthReads = 0;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        statusReads += 1;
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: statusReads === 1 ? 101 : 202,
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, pid: 6101 }));
        return;
      }
      if (url === '/hermes/health/detailed') {
        healthReads += 1;
        res.end(JSON.stringify({ gateway_state: 'running', pid: healthReads === 1 ? 999 : 202 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        // The Dashboard process was replaced, so its new in-memory action
        // table no longer contains the action that initiated the restart.
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: 'stale session token' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pid: 6101, ready: true });
    expect(healthReads).toBe(2);
  });

  it('refuses to claim a restart when the running baseline has no verifiable PID', async () => {
    const requests: string[] = [];
    upstreamHandler = (req, res) => {
      requests.push(`${req.method || 'GET'} ${req.url || '/'}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        gateway_running: true,
        gateway_state: 'running',
        gateway_pid: null,
      }));
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart`,
      { method: 'POST' },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Hermes gateway status could not be verified before restart.',
    });
    expect(requests).toEqual(['GET /hermes-dashboard/api/status']);
  });

  it('does not use an updated timestamp as proof when the gateway PID stays unchanged', async () => {
    let statusReads = 0;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        statusReads += 1;
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: 101,
          gateway_updated_at: statusReads === 1 ? 'before' : 'after',
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, pid: 6201 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        res.end(JSON.stringify({ running: false, exit_code: 9, pid: 6201 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart`,
      { method: 'POST' },
    );

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain('exit 9');
  });

  it('waits for the real default gateway after a profile-scoped restart and repairs a down s6 slot', async () => {
    const upstreamRequests: string[] = [];
    let gatewayStarted = false;
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      upstreamRequests.push(`${req.method || 'GET'} ${url}`);
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        res.end(JSON.stringify(gatewayStarted
          ? {
            gateway_running: true,
            gateway_state: 'running',
            gateway_pid: 202,
            gateway_updated_at: '2026-08-12T10:00:01Z',
          }
          : {
            gateway_running: upstreamRequests.filter((entry) => entry === 'GET /hermes-dashboard/api/status').length === 1,
            gateway_state: upstreamRequests.filter((entry) => entry === 'GET /hermes-dashboard/api/status').length === 1
              ? 'running'
              : 'stopped',
            gateway_pid: upstreamRequests.filter((entry) => entry === 'GET /hermes-dashboard/api/status').length === 1
              ? 101
              : null,
            gateway_updated_at: '2026-08-12T10:00:00Z',
          }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, name: 'gateway-restart', pid: 7001 }));
        return;
      }
      if (url === '/hermes/health/detailed') {
        res.end(JSON.stringify({ gateway_state: 'running', pid: 202 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        res.end(JSON.stringify({
          name: 'gateway-restart',
          running: false,
          exit_code: 0,
          pid: 7001,
          lines: ['credential-shaped output must not be returned'],
        }));
        return;
      }
      if (url === '/hermes/control/gateway/default/up') {
        gatewayStarted = true;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'not found' }));
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart?profile=research`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: 'gateway-restart',
      pid: 7001,
      ready: true,
    });
    expect(upstreamRequests).toContain('POST /hermes-dashboard/api/gateway/restart');
    expect(upstreamRequests).toContain('POST /hermes/control/gateway/default/up');
    expect(upstreamRequests.some((entry) => entry.includes('profile=research'))).toBe(false);
    expect(mocks.releaseWriteLease).toHaveBeenCalledOnce();
  });

  it('returns a bounded restart failure without exposing Hermes action logs', async () => {
    upstreamHandler = (req, res) => {
      const url = req.url || '/';
      res.setHeader('content-type', 'application/json');
      if (url === '/hermes-dashboard/api/status') {
        res.end(JSON.stringify({
          gateway_running: true,
          gateway_state: 'running',
          gateway_pid: 101,
          gateway_updated_at: '2026-08-12T10:00:00Z',
        }));
        return;
      }
      if (url === '/hermes-dashboard/api/gateway/restart') {
        res.end(JSON.stringify({ ok: true, name: 'gateway-restart', pid: 8001 }));
        return;
      }
      if (url === '/hermes-dashboard/api/actions/gateway-restart/status?lines=1') {
        res.end(JSON.stringify({
          name: 'gateway-restart',
          running: false,
          exit_code: 7,
          pid: 8001,
          lines: ['BOT_TOKEN=do-not-leak'],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'not found' }));
    };

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/gateway/restart`,
      { method: 'POST' },
    );
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toContain('exit 7');
    expect(payload.error).not.toContain('BOT_TOKEN');
    expect(payload.error).not.toContain('do-not-leak');
    expect(mocks.releaseWriteLease).toHaveBeenCalledOnce();
  });

  it('rejects dashboard WebSockets opened from another browser origin', async () => {
    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(
        `ws://127.0.0.1:${brokerPort}/agent-runtimes/runtime-1/dashboard/broker-token/api/ws`,
        { origin: 'http://evil.test' },
      );
      websocket.once('open', () => reject(new Error('WebSocket should not have opened.')));
      websocket.once('error', () => undefined);
      websocket.once('unexpected-response', (_request, response) => {
        try {
          expect(response.statusCode).toBe(403);
          expect(mocks.findRuntime).not.toHaveBeenCalled();
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
});
