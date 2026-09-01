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
const MAX_SCREEN_FRAME_BASE64 = 24_000_000;
const MAX_SCREEN_RELAY_BUFFER = 8_000_000;
const MAX_SCREEN_RELAY_MESSAGES = 256;
const SCREEN_TICKET_TTL_MS = 60_000;
const REQUIRED_CONNECTOR_CAPABILITIES = ['process_exec', 'write_file_base64'];

export type ConnectorDevice = {
  kind: string;
  name: string | null;
};

export type ConnectorDisplay = {
  id: string;
  label: string;
  transport: 'snapshot' | 'rfb';
  control: boolean;
  width: number | null;
  height: number | null;
};

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
  device: ConnectorDevice | null;
  displays: ConnectorDisplay[];
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

type ScreenSession = {
  id: string;
  sandboxId: string;
  displayId: string;
  ticket: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  source?: WebSocket;
  viewer?: WebSocket;
  sourceBuffer: Buffer[];
  viewerBuffer: Buffer[];
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
  screenSessions: Map<string, ScreenSession>;
  screenTickets: Map<string, string>;
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
      screenSessions: new Map(),
      screenTickets: new Map(),
    };
  }
  g.__sandboxConnectorBroker.pendingClients ??= new Set();
  g.__sandboxConnectorBroker.screenSessions ??= new Map();
  g.__sandboxConnectorBroker.screenTickets ??= new Map();
  return g.__sandboxConnectorBroker;
}

function text(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, max) || undefined : undefined;
}

function normalizeDevice(value: unknown): ConnectorDevice | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const kind = text(input.kind, 32);
  if (!kind || !/^[a-z0-9_-]+$/i.test(kind)) return null;
  return { kind: kind.toLowerCase(), name: text(input.name) ?? null };
}

function normalizeDisplays(value: unknown): ConnectorDisplay[] {
  if (!Array.isArray(value)) return [];
  const displays: ConnectorDisplay[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const input = item as Record<string, unknown>;
    const id = text(input.id, 128);
    const transport = input.transport === 'snapshot' || input.transport === 'rfb'
      ? input.transport
      : null;
    if (!id || ids.has(id) || !transport) continue;
    ids.add(id);
    const dimension = (size: unknown) => Number.isInteger(size) && Number(size) > 0 && Number(size) <= 32768
      ? Number(size)
      : null;
    displays.push({
      id,
      label: text(input.label, 128) ?? text(input.name, 128) ?? id,
      transport,
      control: input.control === true,
      width: dimension(input.width),
      height: dimension(input.height),
    });
  }
  return displays;
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
    clearScreenSessions(client.sandboxId, 'connector session replaced');
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
    clearScreenSessions(client.sandboxId, 'connector disconnected');
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

function closeScreenSession(session: ScreenSession, reason: string) {
  const s = state();
  if (s.screenSessions.get(session.id) !== session) return;
  s.screenSessions.delete(session.id);
  s.screenTickets.delete(session.ticket);
  clearTimeout(session.timer);
  for (const ws of [session.source, session.viewer]) {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      ws.close(1000, reason.slice(0, 120));
    }
  }
  session.sourceBuffer.length = 0;
  session.viewerBuffer.length = 0;
}

function clearScreenSessions(sandboxId: string, reason: string) {
  for (const session of state().screenSessions.values()) {
    if (session.sandboxId === sandboxId) closeScreenSession(session, reason);
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
    client.root = text(msg.root, 2048);
    client.version = text(msg.version);
    client.platform = text(msg.platform);
    client.arch = text(msg.arch);
    client.shell = text(msg.shell, 1024);
    client.shellFamily = text(msg.shellFamily);
    client.nodeVersion = text(msg.nodeVersion);
    client.device = normalizeDevice(msg.device);
    client.displays = normalizeDisplays(msg.displays);
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

function bearerToken(req: IncomingMessage): string {
  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  return /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '')?.[1] ?? '';
}

function rejectUpgrade(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function screenData(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function relayScreenData(session: ScreenSession, from: 'source' | 'viewer', raw: RawData, isBinary: boolean) {
  if (!isBinary) {
    closeScreenSession(session, 'screen relay requires binary messages');
    return;
  }
  const data = screenData(raw);
  const peer = from === 'source' ? session.viewer : session.source;
  if (peer?.readyState === WebSocket.OPEN) {
    if (peer.bufferedAmount + data.byteLength > MAX_SCREEN_RELAY_BUFFER) {
      closeScreenSession(session, 'screen relay buffer exceeded');
      return;
    }
    peer.send(data, { binary: true });
    return;
  }
  const buffer = from === 'source' ? session.sourceBuffer : session.viewerBuffer;
  if (buffer.length >= MAX_SCREEN_RELAY_MESSAGES
    || buffer.reduce((total, chunk) => total + chunk.byteLength, 0) + data.byteLength > MAX_SCREEN_RELAY_BUFFER) {
    closeScreenSession(session, 'screen relay buffer exceeded');
    return;
  }
  buffer.push(data);
}

function attachScreenSocket(session: ScreenSession, role: 'source' | 'viewer', ws: WebSocket) {
  session[role] = ws;
  ws.on('message', (raw, isBinary) => relayScreenData(session, role, raw, isBinary));
  ws.once('close', () => closeScreenSession(session, `screen ${role} disconnected`));
  ws.once('error', () => closeScreenSession(session, `screen ${role} failed`));

  const peerBuffer = role === 'source' ? session.viewerBuffer : session.sourceBuffer;
  for (const data of peerBuffer) ws.send(data, { binary: true });
  peerBuffer.length = 0;
  if (session.source?.readyState === WebSocket.OPEN && session.viewer?.readyState === WebSocket.OPEN) {
    clearTimeout(session.timer);
  }
}

async function handleConnectorUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const s = state();
  const token = bearerToken(req);
  const sandbox = await findSandboxByConnectorToken(token);
  if (!sandbox) {
    rejectUpgrade(socket, '401 Unauthorized');
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
      device: null,
      displays: [],
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

async function handleScreenSourceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sessionId: string,
) {
  const s = state();
  const session = s.screenSessions.get(sessionId);
  if (!session) {
    rejectUpgrade(socket, '401 Unauthorized');
    return;
  }
  const sandbox = await findSandboxByConnectorToken(bearerToken(req));
  const client = s.clients.get(session.sandboxId);
  if (s.screenSessions.get(sessionId) !== session
    || Date.now() >= session.expiresAt
    || !sandbox
    || sandbox.id !== session.sandboxId
    || sandbox.workspaceId !== client?.workspaceId
    || !client.ready
    || client.ws.readyState !== WebSocket.OPEN
    || !(client.displays ?? []).some((display) => display.id === session.displayId && display.transport === 'rfb')) {
    rejectUpgrade(socket, '401 Unauthorized');
    return;
  }
  if (session.source) {
    rejectUpgrade(socket, '409 Conflict');
    return;
  }
  s.wss?.handleUpgrade(req, socket, head, (ws) => attachScreenSocket(session, 'source', ws));
}

function handleScreenViewerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ticket: string) {
  const s = state();
  const sessionId = s.screenTickets.get(ticket);
  const session = sessionId ? s.screenSessions.get(sessionId) : undefined;
  if (!session || session.ticket !== ticket || Date.now() >= session.expiresAt || session.viewer) {
    rejectUpgrade(socket, '401 Unauthorized');
    return;
  }
  s.screenTickets.delete(ticket);
  s.wss?.handleUpgrade(req, socket, head, (ws) => attachScreenSocket(session, 'viewer', ws));
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/connect') {
    await handleConnectorUpgrade(req, socket, head);
    return;
  }
  const source = /^\/screen\/source\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (source) {
    await handleScreenSourceUpgrade(req, socket, head, source[1]);
    return;
  }
  const viewer = /^\/screen\/view\/([A-Za-z0-9_-]{32,})$/.exec(url.pathname);
  if (viewer) {
    handleScreenViewerUpgrade(req, socket, head, viewer[1]);
    return;
  }
  rejectUpgrade(socket, '404 Not Found');
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

  s.wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SCREEN_FRAME_BASE64 + 1_000_000,
    perMessageDeflate: false,
  });
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

function connectorDisplay(
  sandboxId: string,
  displayId: string,
  transport: ConnectorDisplay['transport'],
): ConnectorDisplay {
  const client = state().clients.get(sandboxId);
  if (!client?.ready || client.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Connector client is not connected.');
  }
  const display = (client.displays ?? []).find((item) => item.id === displayId && item.transport === transport);
  if (!display) throw new Error(`Connector display does not support ${transport}.`);
  return display;
}

export async function captureConnectorScreen(
  sandboxId: string,
  displayId: string,
): Promise<{ data: Uint8Array; contentType: string }> {
  connectorDisplay(sandboxId, displayId, 'snapshot');
  const result = await sendConnectorRequest(sandboxId, 'screen_capture', { displayId }, 15000) as {
    data?: unknown;
    contentType?: unknown;
  };
  const data = result?.data;
  const contentType = result?.contentType;
  const validBase64 = typeof data === 'string'
    && data.length > 0
    && data.length <= MAX_SCREEN_FRAME_BASE64
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data);
  if (!validBase64) throw new Error('Connector returned an invalid screen frame.');
  if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') {
    throw new Error('Connector returned an unsupported screen frame type.');
  }
  return { data: Buffer.from(data, 'base64'), contentType };
}

function connectorPublicWsPath(serverUrl: string, pathname: string): string {
  const explicit = process.env.CONNECTOR_WS_PUBLIC_URL;
  const base = explicit
    ? new URL(explicit)
    : (() => {
        const url = new URL(serverUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.port = String(state().port);
        return url;
      })();
  base.pathname = pathname;
  base.search = '';
  base.hash = '';
  return base.toString();
}

export function connectorScreenViewerUrl(serverUrl: string, ticket: string): string {
  return connectorPublicWsPath(serverUrl, `/screen/view/${encodeURIComponent(ticket)}`);
}

export async function createConnectorScreenSession(
  sandboxId: string,
  displayId: string,
  serverUrl: string,
): Promise<{ sessionId: string; viewerUrl: string; expiresAt: string }> {
  connectorDisplay(sandboxId, displayId, 'rfb');
  await ensureConnectorBroker();
  const s = state();
  for (const existing of s.screenSessions.values()) {
    if (existing.sandboxId === sandboxId && existing.displayId === displayId) {
      closeScreenSession(existing, 'replaced by a newer screen viewer');
    }
  }
  const id = randomUUID();
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SCREEN_TICKET_TTL_MS;
  const session = {
    id,
    sandboxId,
    displayId,
    ticket,
    expiresAt,
    timer: setTimeout(() => {
      const current = state().screenSessions.get(id);
      if (current) closeScreenSession(current, 'screen ticket expired');
    }, SCREEN_TICKET_TTL_MS),
    sourceBuffer: [],
    viewerBuffer: [],
  } satisfies ScreenSession;
  session.timer.unref();
  s.screenSessions.set(id, session);
  s.screenTickets.set(ticket, id);

  try {
    await sendConnectorRequest(sandboxId, 'screen_open', {
      sessionId: id,
      sourceUrl: connectorPublicWsPath(serverUrl, `/screen/source/${id}`),
      displayId,
    }, 10000);
  } catch (error) {
    closeScreenSession(session, 'screen open failed');
    throw error;
  }
  return {
    sessionId: id,
    viewerUrl: connectorScreenViewerUrl(serverUrl, ticket),
    expiresAt: new Date(expiresAt).toISOString(),
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
  device: ConnectorDevice | null;
  displays: ConnectorDisplay[];
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
      device: null,
      displays: [],
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
    device: client.device ?? null,
    displays: client.displays ?? [],
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
  clearScreenSessions(sandboxId, reason);
}

export function connectorPublicWsUrl(serverUrl: string): string {
  return connectorPublicWsPath(serverUrl, '/connect');
}

export async function shutdownConnectorBroker(): Promise<void> {
  const s = state();
  const sandboxIds = new Set([
    ...s.clients.keys(),
    ...[...s.pendingClients].map((client) => client.sandboxId),
  ]);
  for (const sandboxId of sandboxIds) disconnectConnector(sandboxId, 'connector broker stopped');
  for (const session of [...s.screenSessions.values()]) closeScreenSession(session, 'connector broker stopped');
  const server = s.server;
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  s.wss?.close();
  g.__sandboxConnectorBroker = undefined;
}
