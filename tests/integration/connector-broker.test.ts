// @vitest-environment node
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_PROTOCOL_VERSION } from '@/lib/sandboxes/connector';

const mocks = vi.hoisted(() => ({ findSandboxByConnectorToken: vi.fn() }));

vi.mock('@/lib/sandboxes/connector-auth', () => ({
  findSandboxByConnectorToken: mocks.findSandboxByConnectorToken,
}));

let broker: typeof import('@/lib/sandboxes/connector-broker');
let wsUrl = '';

function sandboxRecord() {
  return {
    id: 'sb-broker',
    workspaceId: 'ws-broker',
    deploymentId: 'dep-broker',
    name: 'Broker integration',
    slug: 'broker-integration',
    connector: {},
  };
}

async function openConnector(token = 'mcpcon_broker_test'): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('connector broker integration', () => {
  beforeAll(async () => {
    process.env.CONNECTOR_WS_BIND = '127.0.0.1';
    process.env.CONNECTOR_WS_PORT = '0';
    broker = await import('@/lib/sandboxes/connector-broker');
    const started = await broker.ensureConnectorBroker();
    wsUrl = `ws://127.0.0.1:${started.port}/connect`;
  });

  afterAll(async () => {
    await broker.shutdownConnectorBroker();
    delete process.env.CONNECTOR_WS_BIND;
    delete process.env.CONNECTOR_WS_PORT;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSandboxByConnectorToken.mockImplementation(async (token: string) =>
      token === 'mcpcon_broker_test' ? sandboxRecord() : null,
    );
    broker.disconnectConnector('sb-broker', 'test reset');
  });

  it('authenticates a Bearer WebSocket, negotiates v2 capabilities, and proxies a request', async () => {
    const ws = await openConnector();
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string; id?: string; op?: string };
      if (message.type === 'request' && message.op === 'ping') {
        ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: { ok: true } }));
      }
    });
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      version: '0.1.9',
      root: 'C:\\Users\\Ada\\ToolPlane',
      platform: 'win32',
      arch: 'x64',
      shell: 'powershell.exe',
      shellFamily: 'powershell',
      nodeVersion: '20.0.0',
      capabilities: ['process_exec', 'write_file_base64'],
    }));
    await waitFor(() => broker.connectorStatus('sb-broker').connected);

    const started = await broker.ensureConnectorBroker();
    const response = await fetch(`${started.internalUrl}/internal/connectors/sb-broker/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-broker-token': started.internalToken,
      },
      body: JSON.stringify({ op: 'ping', args: {}, timeoutMs: 1000 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { ok: true } });
    expect(broker.connectorStatus('sb-broker')).toMatchObject({
      connected: true,
      platform: 'win32',
      root: 'C:\\Users\\Ada\\ToolPlane',
    });
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledWith('mcpcon_broker_test');
    ws.close();
  });

  it('revokes an authenticated socket even when hello is delayed', async () => {
    const ws = await openConnector();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    broker.disconnectConnector('sb-broker', 'connector token rotated');

    await expect(closed).resolves.toEqual({ code: 4001, reason: 'connector token rotated' });
    expect(broker.connectorStatus('sb-broker').connected).toBe(false);
  });

  it('revalidates the credential when hello arrives after the upgrade', async () => {
    mocks.findSandboxByConnectorToken
      .mockResolvedValueOnce(sandboxRecord())
      .mockResolvedValueOnce(null);
    const ws = await openConnector();
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));

    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      capabilities: ['process_exec', 'write_file_base64'],
    }));

    await expect(closed).resolves.toBe(4001);
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledTimes(2);
    expect(broker.connectorStatus('sb-broker').connected).toBe(false);
  });

  it('rejects query-string auth and incompatible capabilities', async () => {
    const queryOnly = new WebSocket(`${wsUrl}?token=mcpcon_broker_test`);
    await expect(new Promise<void>((resolve, reject) => {
      queryOnly.once('open', resolve);
      queryOnly.once('error', reject);
    })).rejects.toThrow(/401/);

    const incompatible = await openConnector();
    const closed = new Promise<number>((resolve) => incompatible.once('close', resolve));
    incompatible.send(JSON.stringify({
      type: 'hello',
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      capabilities: ['process_exec'],
    }));
    await expect(closed).resolves.toBe(4002);
    expect(broker.connectorStatus('sb-broker').connected).toBe(false);
  });
});
