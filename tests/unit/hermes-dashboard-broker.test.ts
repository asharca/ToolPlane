// @vitest-environment node
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const mocks = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  findRuntime: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { agentRuntime: { findFirst: mocks.findRuntime } },
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesDashboardReady: mocks.ensureReady,
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
let lastUpstreamRequest: { headers: http.IncomingHttpHeaders; url: string } | null = null;

describe('Hermes dashboard separate-origin broker', () => {
  beforeAll(async () => {
    vi.stubEnv('HERMES_DASHBOARD_BIND', '127.0.0.1');
    vi.stubEnv('HERMES_DASHBOARD_PORT', '0');
    upstream = http.createServer((req, res) => {
      lastUpstreamRequest = { headers: req.headers, url: req.url || '/' };
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        etag: 'upstream-html',
      });
      res.end([
        '<script>window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=true;</script>',
        '<script>localStorage.getItem("hermes-theme")</script>',
      ].join(''));
    });
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
    mocks.verifyToken.mockImplementation((_runtimeId: string, token: string) => (
      token === 'broker-token'
        ? { expiresAt: 2_000_000_000, parentOrigin: 'http://toolplane.test:3000' }
        : null
    ));
    mocks.findRuntime.mockResolvedValue({
      id: 'runtime-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
    });
    mocks.ensureReady.mockResolvedValue({ port: upstreamPort });
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
