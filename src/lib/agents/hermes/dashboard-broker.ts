import 'server-only';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { db } from '@/lib/db';
import { sandboxContainerName } from '@/lib/sandboxes/runtime';
import { ensureHermesDashboardReady } from './runtime';
import { verifyHermesDashboardBrokerAccessToken } from './token';

const DEFAULT_DASHBOARD_BROKER_PORT = 9332;
const DEFAULT_DASHBOARD_BROKER_BIND = '0.0.0.0';
const MAX_REQUEST_BYTES = 32_000_000;
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_WEBSOCKET_BUFFER_BYTES = 4_000_000;
const SETTINGS_CLOSE_MESSAGE = 'toolplane:close-agent-settings';
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
  'x-hermes-session-token',
];
const RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
];

type DashboardBrokerState = {
  bind: string;
  port: number;
  handler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  upgradeAttached?: boolean;
  upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  server?: http.Server;
  starting?: Promise<void>;
  wss?: WebSocketServer;
};

type DashboardWebSocketBridgeMessage = {
  type?: string;
  binary?: boolean;
  code?: number;
  data?: string;
};

const HERMES_WEBSOCKET_BRIDGE = String.raw`
import base64
import json
import sys
import threading

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

bootstrap = json.loads(sys.stdin.buffer.readline())
url = bootstrap["url"]
write_lock = threading.Lock()

def emit(value):
    line = json.dumps(value, separators=(",", ":")) + "\n"
    with write_lock:
        sys.stdout.write(line)
        sys.stdout.flush()

try:
    with connect(
        url,
        origin="http://127.0.0.1:9119",
        open_timeout=10,
        close_timeout=5,
        max_size=None,
        proxy=None,
    ) as websocket:
        emit({"type": "open"})

        def relay_input():
            try:
                for raw_line in sys.stdin.buffer:
                    message = json.loads(raw_line)
                    if message.get("type") == "message":
                        payload = base64.b64decode(message.get("data", ""))
                        websocket.send(payload if message.get("binary") else payload.decode("utf-8"))
                    elif message.get("type") == "close":
                        websocket.close(
                            code=int(message.get("code") or 1000),
                            reason=str(message.get("reason") or "")[:123],
                        )
                        return
            except Exception:
                try:
                    websocket.close(code=1011, reason="bridge input failed")
                except Exception:
                    pass
            finally:
                try:
                    websocket.close(code=1000)
                except Exception:
                    pass

        threading.Thread(target=relay_input, daemon=True).start()
        try:
            for payload in websocket:
                binary = isinstance(payload, (bytes, bytearray))
                data = bytes(payload) if binary else str(payload).encode("utf-8")
                emit({
                    "type": "message",
                    "binary": binary,
                    "data": base64.b64encode(data).decode("ascii"),
                })
        except ConnectionClosed as closed:
            received = closed.rcvd
            emit({
                "type": "close",
                "code": received.code if received else 1000,
            })
except Exception:
    emit({"type": "error"})
    raise
`;

const g = globalThis as unknown as {
  __hermesDashboardBroker?: DashboardBrokerState;
};

function configuredPort(): number {
  const value = Number(process.env.HERMES_DASHBOARD_PORT ?? DEFAULT_DASHBOARD_BROKER_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65535
    ? value
    : DEFAULT_DASHBOARD_BROKER_PORT;
}

function state(): DashboardBrokerState {
  if (!g.__hermesDashboardBroker) {
    g.__hermesDashboardBroker = {
      bind: process.env.HERMES_DASHBOARD_BIND || DEFAULT_DASHBOARD_BROKER_BIND,
      port: configuredPort(),
    };
  }
  return g.__hermesDashboardBroker;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function websocketBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function bridgeInputLine(data: RawData, binary: boolean): string {
  return `${JSON.stringify({
    type: 'message',
    binary,
    data: websocketBuffer(data).toString('base64'),
  })}\n`;
}

function closeCodeForBrowser(value: unknown): number {
  const code = Number(value);
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

function bridgeHermesDashboardWebSocket(
  browser: WebSocket,
  sandboxId: string,
  upstreamUrl: string,
) {
  const child = spawn(
    'docker',
    [
      'exec',
      '--user',
      'hermes',
      '-i',
      sandboxContainerName(sandboxId),
      '/opt/hermes/.venv/bin/python3',
      '-u',
      '-c',
      HERMES_WEBSOCKET_BRIDGE,
    ],
    { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  let opened = false;
  let stdout = '';
  let pendingBytes = 0;
  const pending: string[] = [];

  child.stdin.write(`${JSON.stringify({ type: 'connect', url: upstreamUrl })}\n`);

  const stopChild = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  };

  const closeBrowser = (code = 1011) => {
    if (browser.readyState === WebSocket.OPEN) {
      browser.close(code, code === 1000 ? '' : 'Hermes dashboard WebSocket unavailable.');
    }
  };

  const writeBridgeInput = (line: string) => {
    if (child.stdin.destroyed || child.exitCode !== null) return;
    child.stdin.write(line);
  };

  browser.on('message', (data, binary) => {
    const line = bridgeInputLine(data, binary);
    if (opened) {
      writeBridgeInput(line);
      return;
    }
    pendingBytes += Buffer.byteLength(line);
    if (pendingBytes > MAX_WEBSOCKET_BUFFER_BYTES) {
      closeBrowser(1009);
      stopChild();
      return;
    }
    pending.push(line);
  });
  browser.on('close', (code, reason) => {
    writeBridgeInput(`${JSON.stringify({
      type: 'close',
      code,
      reason: reason.toString('utf8').slice(0, 123),
    })}\n`);
    child.stdin.end();
    stopChild();
  });
  browser.on('error', stopChild);

  child.stdin.on('error', () => closeBrowser());
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_WEBSOCKET_BUFFER_BYTES * 2) {
      closeBrowser(1009);
      stopChild();
      return;
    }
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
      if (!line) continue;

      let message: DashboardWebSocketBridgeMessage;
      try {
        message = JSON.parse(line) as DashboardWebSocketBridgeMessage;
      } catch {
        closeBrowser();
        stopChild();
        return;
      }
      if (message.type === 'open') {
        opened = true;
        for (const queued of pending.splice(0)) writeBridgeInput(queued);
        pendingBytes = 0;
      } else if (message.type === 'message' && typeof message.data === 'string') {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(Buffer.from(message.data, 'base64'), { binary: Boolean(message.binary) });
        }
      } else if (message.type === 'close') {
        closeBrowser(closeCodeForBrowser(message.code));
      } else if (message.type === 'error') {
        closeBrowser();
      }
    }
  });
  child.on('error', () => closeBrowser());
  child.on('close', (code) => closeBrowser(opened && code === 0 ? 1000 : 1011));
}

function rejectWebSocketUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  const statusText = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : 'Service Unavailable';
  socket.write([
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
  socket.destroy();
}

function firstNodeHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || null;
}

function websocketOriginMatchesBroker(req: IncomingMessage): boolean {
  const origin = firstNodeHeader(req.headers.origin);
  const host = firstNodeHeader(req.headers['x-forwarded-host'])
    ?? firstNodeHeader(req.headers.host);
  if (!origin || !host) return false;
  const forwardedProto = firstNodeHeader(req.headers['x-forwarded-proto'])?.toLowerCase();
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

async function upgradeHermesDashboardWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const match = /^\/agent-runtimes\/([^/]+)\/dashboard\/([^/]+)(\/.*)?$/.exec(
    requestUrl.pathname,
  );
  if (!match) {
    rejectWebSocketUpgrade(socket, 404, 'not found');
    return;
  }

  let runtimeId: string;
  let accessToken: string;
  try {
    runtimeId = decodeURIComponent(match[1]);
    accessToken = decodeURIComponent(match[2]);
  } catch {
    rejectWebSocketUpgrade(socket, 404, 'invalid dashboard path');
    return;
  }
  if (!verifyHermesDashboardBrokerAccessToken(runtimeId, accessToken)) {
    rejectWebSocketUpgrade(socket, 401, 'Dashboard access is invalid or expired.');
    return;
  }
  if (!websocketOriginMatchesBroker(req)) {
    rejectWebSocketUpgrade(socket, 403, 'Dashboard WebSocket origin is invalid.');
    return;
  }

  const managedRuntime = await db.agentRuntime.findFirst({
    where: { id: runtimeId, kind: 'hermes' },
    select: { id: true, workspaceId: true, agentId: true, sandboxId: true },
  });
  if (!managedRuntime) {
    rejectWebSocketUpgrade(socket, 401, 'Dashboard access is invalid or expired.');
    return;
  }
  const ready = await ensureHermesDashboardReady(
    managedRuntime.workspaceId,
    managedRuntime.agentId,
  );
  if (!ready.port) {
    rejectWebSocketUpgrade(socket, 503, 'Hermes dashboard is unavailable.');
    return;
  }

  const upstreamUrl = new URL('ws://127.0.0.1:9119');
  upstreamUrl.pathname = match[3] || '/';
  upstreamUrl.search = requestUrl.search;
  const wss = state().wss;
  if (!wss) {
    rejectWebSocketUpgrade(socket, 503, 'Hermes dashboard broker is unavailable.');
    return;
  }
  wss.handleUpgrade(req, socket, head, (browser) => {
    bridgeHermesDashboardWebSocket(browser, managedRuntime.sandboxId, upstreamUrl.toString());
  });
}

function attachUpgradeHandler(s: DashboardBrokerState) {
  if (!s.server || s.upgradeAttached) return;
  s.server.on('upgrade', (req, socket, head) => {
    const handler = state().upgradeHandler;
    if (!handler) {
      rejectWebSocketUpgrade(socket, 503, 'Hermes dashboard broker is unavailable.');
      return;
    }
    void handler(req, socket, head).catch(() => {
      rejectWebSocketUpgrade(socket, 503, 'Hermes dashboard WebSocket unavailable.');
    });
  });
  s.upgradeAttached = true;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function publicPrefix(runtimeId: string, accessToken: string): string {
  return `/agent-runtimes/${encodeURIComponent(runtimeId)}/dashboard/${encodeURIComponent(accessToken)}`;
}

function contentSecurityPolicy(parentOrigin: string): string {
  return [
    "default-src 'none'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    `frame-ancestors ${parentOrigin}`,
    "frame-src 'self' blob:",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; ');
}

function setSecurityHeaders(res: ServerResponse, parentOrigin: string) {
  res.setHeader('content-security-policy', contentSecurityPolicy(parentOrigin));
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function injectSettingsEscapeBridge(html: string): string {
  if (html.includes(SETTINGS_CLOSE_MESSAGE)) return html;
  const bridge = `<script>window.addEventListener("keydown",function(event){if(event.key==="Escape"){event.preventDefault();event.stopPropagation();window.parent.postMessage("${SETTINGS_CLOSE_MESSAGE}","*");}},true);</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${bridge}</head>`)
    : `${bridge}${html}`;
}

async function readRequestBody(req: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (METHODS_WITHOUT_BODY.has(req.method ?? 'GET')) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks);
  const body = new ArrayBuffer(source.byteLength);
  new Uint8Array(body).set(source);
  return body;
}

async function pipeResponseBody(body: ReadableStream<Uint8Array>, res: ServerResponse) {
  const reader = body.getReader();
  res.on('close', () => {
    if (!res.writableEnded) void reader.cancel();
  });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) await once(res, 'drain');
  }
  res.end();
}

function rewrittenLocation(
  location: string,
  upstreamUrl: URL,
  prefix: string,
): string {
  try {
    const target = new URL(location, upstreamUrl);
    if (target.origin !== upstreamUrl.origin) return location;
    const path = target.pathname.startsWith('/hermes-dashboard')
      ? target.pathname.slice('/hermes-dashboard'.length) || '/'
      : target.pathname;
    return `${prefix}${path}${target.search}${target.hash}`;
  } catch {
    return location;
  }
}

async function proxyDashboard(req: IncomingMessage, res: ServerResponse) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const match = /^\/agent-runtimes\/([^/]+)\/dashboard\/([^/]+)(\/.*)?$/.exec(
    requestUrl.pathname,
  );
  if (!match) {
    json(res, 404, { error: 'not found' });
    return;
  }

  let runtimeId: string;
  let accessToken: string;
  try {
    runtimeId = decodeURIComponent(match[1]);
    accessToken = decodeURIComponent(match[2]);
  } catch {
    json(res, 400, { error: 'invalid dashboard path' });
    return;
  }
  const access = verifyHermesDashboardBrokerAccessToken(runtimeId, accessToken);
  if (!access) {
    json(res, 401, { error: 'Dashboard access is invalid or expired.' });
    return;
  }

  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    json(res, 413, { error: 'Dashboard request body is too large.' });
    return;
  }

  const managedRuntime = await db.agentRuntime.findFirst({
    where: { id: runtimeId, kind: 'hermes' },
    select: { id: true, workspaceId: true, agentId: true },
  });
  if (!managedRuntime) {
    json(res, 401, { error: 'Dashboard access is invalid or expired.' });
    return;
  }

  const ready = await ensureHermesDashboardReady(
    managedRuntime.workspaceId,
    managedRuntime.agentId,
  );
  if (!ready.port) {
    json(res, 503, { error: ready.error || 'Hermes dashboard is unavailable.' });
    return;
  }

  let body: ArrayBuffer | undefined;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
      json(res, 413, { error: 'Dashboard request body is too large.' });
      return;
    }
    throw error;
  }

  const suffix = match[3] || '/';
  const upstreamUrl = new URL(`http://127.0.0.1:${ready.port}`);
  upstreamUrl.pathname = `/hermes-dashboard${suffix}`;
  upstreamUrl.search = requestUrl.search;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const prefix = publicPrefix(runtimeId, accessToken);
  headers.set('x-forwarded-prefix', prefix);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    json(res, 502, {
      error: error instanceof Error ? error.message : 'Hermes dashboard proxy failed.',
    });
    return;
  }

  res.statusCode = upstream.status;
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  const location = upstream.headers.get('location');
  if (location) res.setHeader('location', rewrittenLocation(location, upstreamUrl, prefix));
  setSecurityHeaders(res, access.parentOrigin);

  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    res.removeHeader('etag');
    res.setHeader('cache-control', 'no-store');
    res.end(injectSettingsEscapeBridge(await upstream.text()));
    return;
  }

  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeResponseBody(upstream.body, res);
}

export async function ensureHermesDashboardBroker(): Promise<{
  bind: string;
  port: number;
}> {
  const s = state();
  s.handler = proxyDashboard;
  s.upgradeHandler = upgradeHermesDashboardWebSocket;
  s.wss ??= new WebSocketServer({ noServer: true });
  attachUpgradeHandler(s);
  if (s.server?.listening) return { bind: s.bind, port: s.port };
  if (s.starting) {
    await s.starting;
    return { bind: s.bind, port: s.port };
  }

  s.server = http.createServer((req, res) => {
    void state().handler?.(req, res).catch((error) => {
      if (!res.headersSent) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  attachUpgradeHandler(s);
  s.starting = new Promise<void>((resolve, reject) => {
    s.server?.once('error', reject);
    s.server?.listen(s.port, s.bind, () => {
      s.server?.off('error', reject);
      const address = s.server?.address();
      if (address && typeof address === 'object') s.port = address.port;
      resolve();
    });
  });
  try {
    await s.starting;
  } finally {
    s.starting = undefined;
  }

  console.log(`[hermes-dashboard] broker listening on ${s.bind}:${s.port}`);
  return { bind: s.bind, port: s.port };
}

export function hermesDashboardBrokerPublicUrl(
  requestUrl: string,
  runtimeId: string,
  accessToken: string,
  path: string[] = [],
  port = state().port,
): string {
  const parent = new URL(requestUrl);
  const explicit = process.env.HERMES_DASHBOARD_PUBLIC_URL?.trim();
  const target = explicit ? new URL(explicit) : new URL(parent.origin);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('HERMES_DASHBOARD_PUBLIC_URL must use http or https.');
  }
  if (explicit && (target.pathname !== '/' || target.search || target.hash)) {
    throw new Error('HERMES_DASHBOARD_PUBLIC_URL must be an origin without a path.');
  }
  if (!explicit) target.port = String(port);
  if (target.origin === parent.origin) {
    throw new Error('Hermes dashboard public URL must use a different origin from ToolPlane.');
  }

  target.pathname = `${publicPrefix(runtimeId, accessToken)}/${path.map(encodeURIComponent).join('/')}`;
  target.search = parent.search;
  target.hash = '';
  return target.toString();
}

export async function closeHermesDashboardBroker() {
  const s = g.__hermesDashboardBroker;
  if (!s?.server) return;
  for (const client of s.wss?.clients ?? []) client.terminate();
  s.wss?.close();
  await new Promise<void>((resolve, reject) => {
    s.server?.close((error) => (error ? reject(error) : resolve()));
  });
  g.__hermesDashboardBroker = undefined;
}
