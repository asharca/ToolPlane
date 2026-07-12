import 'server-only';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { CONNECTOR_PROTOCOL_VERSION } from './connector';
import { findSandboxByConnectorToken } from './connector-auth';

const DEFAULT_CONNECTOR_WS_PORT = 9321;
const DEFAULT_CONNECTOR_WS_BIND = '0.0.0.0';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY = 4_000_000;
const MAX_TERMINAL_BUFFER = 200;
const REQUIRED_CONNECTOR_CAPABILITIES = ['process_exec', 'write_file_base64'];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectorClient = {
  sandboxId: string;
  workspaceId: string;
  ws: WebSocket;
  ready: boolean;
  connectedAt: string;
  lastSeen: string;
  root?: string;
  version?: string;
  platform?: string;
  arch?: string;
  shell?: string;
  shellFamily?: string;
  nodeVersion?: string;
  capabilities: string[];
  token?: string;
  pending: Map<string, PendingRequest>;
};

type TerminalSession = {
  sandboxId: string;
  terminalId: string;
  buffer: string[];
  streams: Set<ServerResponse>;
};

type BrokerState = {
  server?: http.Server;
  wss?: WebSocketServer;
  bind: string;
  port: number;
  internalToken: string;
  clients: Map<string, ConnectorClient>;
  pendingClients: Set<ConnectorClient>;
  terminalSessions: Map<string, TerminalSession>;
};

const g = globalThis as unknown as { __sandboxConnectorBroker?: BrokerState };

function state(): BrokerState {
  if (!g.__sandboxConnectorBroker) {
    const configuredPort = process.env.CONNECTOR_WS_PORT == null
      ? DEFAULT_CONNECTOR_WS_PORT
      : Number(process.env.CONNECTOR_WS_PORT);
    g.__sandboxConnectorBroker = {
      bind: process.env.CONNECTOR_WS_BIND || DEFAULT_CONNECTOR_WS_BIND,
      port: Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
        ? configuredPort
        : DEFAULT_CONNECTOR_WS_PORT,
      internalToken: process.env.CONNECTOR_BROKER_TOKEN || randomBytes(32).toString('base64url'),
      clients: new Map(),
      pendingClients: new Set(),
      terminalSessions: new Map(),
    };
  }
  g.__sandboxConnectorBroker.pendingClients ??= new Set();
  return g.__sandboxConnectorBroker;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => resolve(body));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body) return {};
  const parsed = JSON.parse(body);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

function terminalKey(sandboxId: string, terminalId: string) {
  return `${sandboxId}:${terminalId}`;
}

function ensureTerminalSession(sandboxId: string, terminalId: string): TerminalSession {
  const s = state();
  const key = terminalKey(sandboxId, terminalId);
  let session = s.terminalSessions.get(key);
  if (!session) {
    session = { sandboxId, terminalId, buffer: [], streams: new Set() };
    s.terminalSessions.set(key, session);
  }
  return session;
}

function pushTerminalEvent(sandboxId: string, terminalId: string, event: string, value: unknown) {
  const session = ensureTerminalSession(sandboxId, terminalId);
  const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  session.buffer.push(payload);
  if (session.buffer.length > MAX_TERMINAL_BUFFER) session.buffer.shift();
  for (const stream of session.streams) stream.write(payload);
  if (event === 'exit') {
    setTimeout(() => {
      for (const stream of session.streams) stream.end();
      state().terminalSessions.delete(terminalKey(sandboxId, terminalId));
    }, 3000).unref();
  }
}

function attachClient(client: ConnectorClient) {
  const s = state();
  s.pendingClients.delete(client);
  const existing = s.clients.get(client.sandboxId);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    clearTerminalSessions(client.sandboxId);
    existing.ws.close(4000, 'replaced by a newer connector session');
  }
  s.clients.set(client.sandboxId, client);
}

function detachClient(client: ConnectorClient) {
  const s = state();
  s.pendingClients.delete(client);
  const wasActive = s.clients.get(client.sandboxId) === client;
  if (wasActive) {
    s.clients.delete(client.sandboxId);
    clearTerminalSessions(client.sandboxId);
  }
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Connector client disconnected.'));
  }
  client.token = undefined;
  client.pending.clear();
}

function clearTerminalSessions(sandboxId: string) {
  const s = state();
  for (const [key, session] of s.terminalSessions) {
    if (session.sandboxId !== sandboxId) continue;
    for (const stream of session.streams) stream.end();
    s.terminalSessions.delete(key);
  }
}

function sendConnectorRequest(
  sandboxId: string,
  op: string,
  args: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const client = state().clients.get(sandboxId);
  if (!client?.ready || client.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Connector client is not connected.'));
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`Connector request timed out: ${op}`));
    }, Math.min(Math.max(Number(timeoutMs) || REQUEST_TIMEOUT_MS, 1), 120000));
    client.pending.set(id, { resolve, reject, timer });
    client.ws.send(JSON.stringify({
      type: 'request',
      id,
      op,
      args,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    }));
  });
}

async function handleWsMessage(client: ConnectorClient, raw: RawData) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  client.lastSeen = new Date().toISOString();

  if (msg.type === 'hello') {
    if (client.ready) return;
    const current = await findSandboxByConnectorToken(client.token ?? '');
    if (current?.id !== client.sandboxId
      || current.workspaceId !== client.workspaceId
      || !state().pendingClients.has(client)
      || client.ws.readyState !== WebSocket.OPEN) {
      client.ws.close(4001, 'connector credential is no longer active');
      return;
    }
    const capabilities = Array.isArray(msg.capabilities)
      ? msg.capabilities.filter((value): value is string => typeof value === 'string').slice(0, 32)
      : [];
    const compatible = msg.protocolVersion === CONNECTOR_PROTOCOL_VERSION
      && REQUIRED_CONNECTOR_CAPABILITIES.every((capability) => capabilities.includes(capability));
    if (!compatible) {
      client.ws.close(4002, 'connector upgrade required');
      return;
    }
    const text = (value: unknown, max = 256) => typeof value === 'string' ? value.slice(0, max) : undefined;
    client.root = text(msg.root, 2048);
    client.version = text(msg.version);
    client.platform = text(msg.platform);
    client.arch = text(msg.arch);
    client.shell = text(msg.shell, 1024);
    client.shellFamily = text(msg.shellFamily);
    client.nodeVersion = text(msg.nodeVersion);
    client.capabilities = capabilities;
    client.token = undefined;
    client.ready = true;
    attachClient(client);
    return;
  }

  if (!client.ready) return;

  if (msg.type === 'response') {
    const id = String(msg.id ?? '');
    const pending = client.pending.get(id);
    if (!pending) return;
    client.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error ?? 'Connector request failed.')));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (msg.type === 'terminal_data' && typeof msg.terminalId === 'string') {
    pushTerminalEvent(client.sandboxId, msg.terminalId, 'data', { data: String(msg.data ?? '') });
    return;
  }

  if (msg.type === 'terminal_exit' && typeof msg.terminalId === 'string') {
    pushTerminalEvent(client.sandboxId, msg.terminalId, 'exit', {
      exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
      signal: typeof msg.signal === 'string' ? msg.signal : null,
    });
  }
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const s = state();
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const token = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '')?.[1] ?? '';
  const sandbox = await findSandboxByConnectorToken(token);
  if (!sandbox) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  s.wss?.handleUpgrade(req, socket, head, (ws) => {
    const now = new Date().toISOString();
    const client: ConnectorClient = {
      sandboxId: sandbox.id,
      workspaceId: sandbox.workspaceId,
      ws,
      ready: false,
      connectedAt: now,
      lastSeen: now,
      capabilities: [],
      token,
      pending: new Map(),
    };
    s.pendingClients.add(client);
    ws.on('message', (raw) => {
      void handleWsMessage(client, raw).catch(() => ws.close(1011, 'connector message failed'));
    });
    ws.on('close', () => detachClient(client));
    ws.on('error', () => detachClient(client));
    ws.send(JSON.stringify({
      type: 'accepted',
      sandboxId: sandbox.id,
      workspaceId: sandbox.workspaceId,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    }));
  });
}

function assertInternal(req: IncomingMessage): boolean {
  return req.headers['x-connector-broker-token'] === state().internalToken;
}

async function handleInternalRequest(req: IncomingMessage, res: ServerResponse) {
  const s = state();
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, { status: 'ok', protocolVersion: CONNECTOR_PROTOCOL_VERSION });
    return;
  }

  if (!url.pathname.startsWith('/internal/')) {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (!assertInternal(req)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  const sessionMatch = /^\/internal\/connectors\/([^/]+)\/terminal\/session(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
  if (sessionMatch) {
    const [, sandboxIdRaw, terminalIdRaw, action] = sessionMatch;
    const sandboxId = decodeURIComponent(sandboxIdRaw);
    const terminalId = terminalIdRaw ? decodeURIComponent(terminalIdRaw) : '';

    try {
      if (req.method === 'POST' && !terminalId) {
        const body = await readJson(req);
        const result = await sendConnectorRequest(sandboxId, 'terminal_create', body, 10000) as { terminalId?: string };
        if (!result.terminalId) throw new Error('Connector did not return a terminal id.');
        ensureTerminalSession(sandboxId, result.terminalId);
        json(res, 201, { id: result.terminalId });
        return;
      }

      if (req.method === 'GET' && action === 'stream' && terminalId) {
        const session = ensureTerminalSession(sandboxId, terminalId);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('event: ready\ndata: {}\n\n');
        for (const payload of session.buffer) res.write(payload);
        session.streams.add(res);
        req.on('close', () => session.streams.delete(res));
        return;
      }

      if (req.method === 'POST' && action && terminalId) {
        const body = await readJson(req);
        const op = action === 'input'
          ? 'terminal_input'
          : action === 'resize'
            ? 'terminal_resize'
            : '';
        if (!op) {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        await sendConnectorRequest(sandboxId, op, { ...body, terminalId }, 10000);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && terminalId && !action) {
        await sendConnectorRequest(sandboxId, 'terminal_close', { terminalId }, 10000).catch(() => null);
        const session = s.terminalSessions.get(terminalKey(sandboxId, terminalId));
        if (session) {
          for (const stream of session.streams) stream.end();
          s.terminalSessions.delete(terminalKey(sandboxId, terminalId));
        }
        json(res, 200, { ok: true });
        return;
      }
    } catch (error) {
      json(res, 409, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  const requestMatch = /^\/internal\/connectors\/([^/]+)\/request$/.exec(url.pathname);
  if (requestMatch && req.method === 'POST') {
    const sandboxId = decodeURIComponent(requestMatch[1]);
    try {
      const body = await readJson(req);
      const result = await sendConnectorRequest(
        sandboxId,
        String(body.op ?? ''),
        body.args ?? {},
        Number(body.timeoutMs ?? REQUEST_TIMEOUT_MS),
      );
      json(res, 200, { result });
    } catch (error) {
      json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

export async function ensureConnectorBroker(): Promise<{
  port: number;
  internalUrl: string;
  internalToken: string;
}> {
  const s = state();
  if (s.server?.listening) {
    return {
      port: s.port,
      internalUrl: `http://127.0.0.1:${s.port}`,
      internalToken: s.internalToken,
    };
  }

  s.wss = new WebSocketServer({ noServer: true });
  s.server = http.createServer((req, res) => {
    void handleInternalRequest(req, res).catch((error) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  s.server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    s.server?.once('error', reject);
    s.server?.listen(s.port, s.bind, () => {
      const address = s.server?.address();
      if (address && typeof address === 'object') s.port = address.port;
      s.server?.off('error', reject);
      resolve();
    });
  });

  console.log(`[connector] WebSocket broker listening on ${s.bind}:${s.port}`);
  return {
    port: s.port,
    internalUrl: `http://127.0.0.1:${s.port}`,
    internalToken: s.internalToken,
  };
}

export function connectorStatus(sandboxId: string): {
  connected: boolean;
  connectedAt: string | null;
  lastSeen: string | null;
  root: string | null;
  version: string | null;
  platform: string | null;
  arch: string | null;
  shell: string | null;
  shellFamily: string | null;
  nodeVersion: string | null;
  capabilities: string[];
} {
  const client = state().clients.get(sandboxId);
  if (!client?.ready || client.ws.readyState !== WebSocket.OPEN) {
    return {
      connected: false,
      connectedAt: null,
      lastSeen: null,
      root: null,
      version: null,
      platform: null,
      arch: null,
      shell: null,
      shellFamily: null,
      nodeVersion: null,
      capabilities: [],
    };
  }
  return {
    connected: true,
    connectedAt: client.connectedAt,
    lastSeen: client.lastSeen,
    root: client.root ?? null,
    version: client.version ?? null,
    platform: client.platform ?? null,
    arch: client.arch ?? null,
    shell: client.shell ?? null,
    shellFamily: client.shellFamily ?? null,
    nodeVersion: client.nodeVersion ?? null,
    capabilities: client.capabilities,
  };
}

export function disconnectConnector(sandboxId: string, reason = 'connector session revoked'): void {
  const s = state();
  const clients = new Set(
    [...s.pendingClients].filter((client) => client.sandboxId === sandboxId),
  );
  const active = s.clients.get(sandboxId);
  if (active) clients.add(active);
  for (const client of clients) {
    detachClient(client);
    if (client.ws.readyState === WebSocket.CONNECTING || client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(4001, reason.slice(0, 120));
    }
  }
  clearTerminalSessions(sandboxId);
}

export function connectorPublicWsUrl(serverUrl: string): string {
  const explicit = process.env.CONNECTOR_WS_PUBLIC_URL;
  const base = explicit
    ? new URL(explicit)
    : (() => {
        const url = new URL(serverUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.port = String(state().port);
        return url;
      })();
  base.pathname = '/connect';
  base.search = '';
  return base.toString();
}

export async function shutdownConnectorBroker(): Promise<void> {
  const s = state();
  const sandboxIds = new Set([
    ...s.clients.keys(),
    ...[...s.pendingClients].map((client) => client.sandboxId),
  ]);
  for (const sandboxId of sandboxIds) disconnectConnector(sandboxId, 'connector broker stopped');
  const server = s.server;
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  s.wss?.close();
  g.__sandboxConnectorBroker = undefined;
}
