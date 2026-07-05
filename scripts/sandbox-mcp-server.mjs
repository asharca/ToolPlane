// MCP server for one agent sandbox. It exposes a small Linux-like workspace
// surface over JSON-RPC HTTP: shell execution, bounded file operations, and a
// PTY terminal stream. Docker sandboxes run in a persistent container + volume.
// Connector sandboxes use a user-started WebSocket agent; this process proxies
// sandbox operations through the in-process connector broker.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pty from 'node-pty';

const NAME = process.env.MCP_NAME || 'sandbox';
const KIND = process.env.SANDBOX_KIND === 'connector' ? 'connector' : 'docker';
const SANDBOX_ID = process.env.SANDBOX_ID || 'sandbox';
const IMAGE = process.env.SANDBOX_IMAGE || 'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm';
const VOLUME = process.env.SANDBOX_VOLUME || `toolplane_sandbox_${SANDBOX_ID.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
const NETWORK = process.env.SANDBOX_NETWORK === 'none' ? 'none' : 'mcp-sandbox';
const CONNECTOR_REMOTE_ROOT = (process.env.SANDBOX_CONNECTOR_REMOTE_ROOT || '/tmp/toolplane-sandbox').replace(/\/+$/, '') || '.';
const CONNECTOR_BROKER_URL = (process.env.SANDBOX_CONNECTOR_BROKER_URL || 'http://127.0.0.1:9321').replace(/\/+$/, '');
const CONNECTOR_BROKER_TOKEN = process.env.SANDBOX_CONNECTOR_BROKER_TOKEN || '';
const CONTAINER = `toolplane-sandbox-${SANDBOX_ID.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
const PROTOCOL_VERSION = '2025-06-18';
const VERSION = '1.0.0';
const MAX_BODY = 2_000_000;
const MAX_OUTPUT = 128_000;
const MAX_WRITE = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TERMINAL_BUFFER = 200;
const DOCKER_SANDBOX_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

const TOOLS = [
  {
    name: 'sandbox_info',
    description: 'Return sandbox identity, mode, image/root, and workspace path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shell_exec',
    description: 'Run a shell command inside the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Relative working directory under /workspace.' },
        stdin: { type: 'string', description: 'Optional standard input.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds, max 120000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files under a relative sandbox workspace path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path.' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a UTF-8 text file inside the sandbox workspace, creating parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path.' },
        content: { type: 'string', description: 'Text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

function truncate(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT).toString('utf8')}\n[output truncated]`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeRel(raw = '.') {
  const input = String(raw || '.').replace(/\\/g, '/').trim() || '.';
  if (input.startsWith('/') || input.includes('\0')) return null;
  const normal = path.posix.normalize(input);
  if (normal === '..' || normal.startsWith('../')) return null;
  return normal === '.' ? '' : normal;
}

async function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = Math.min(Math.max(Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (b) => {
      stdout = truncate(stdout + b.toString('utf8'));
    });
    child.stderr.on('data', (b) => {
      stderr = truncate(stderr + b.toString('utf8'));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: String(error.message) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
    child.stdin.end(String(opts.stdin ?? '').slice(0, MAX_WRITE));
  });
}

function readBody(req, max = MAX_BODY) {
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

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function dockerEnv() {
  const keys = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function connectorHeaders(extra = {}) {
  return {
    ...extra,
    'x-connector-broker-token': CONNECTOR_BROKER_TOKEN,
  };
}

async function connectorFetch(pathname, init = {}) {
  return fetch(`${CONNECTOR_BROKER_URL}${pathname}`, {
    ...init,
    headers: connectorHeaders(init.headers ?? {}),
  });
}

async function connectorRequest(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await connectorFetch(`/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args, timeoutMs }),
    signal: AbortSignal.timeout(Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS) + 1000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error ?? `connector broker request failed (${res.status})`));
  return json.result;
}

async function connectorTool(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, isError = () => false) {
  try {
    const result = await connectorRequest(op, args, timeoutMs);
    return textResult(result, isError(result));
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

async function dockerInspectJson() {
  const inspected = await run('docker', ['inspect', CONTAINER], { env: dockerEnv(), timeoutMs: 10_000 });
  if (inspected.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(inspected.stdout);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
}

function hasExpectedDockerSandboxCaps(info) {
  const hostConfig = info?.HostConfig ?? {};
  const capDrop = new Set((hostConfig.CapDrop ?? []).map((cap) => String(cap).toUpperCase()));
  const capAdd = new Set((hostConfig.CapAdd ?? []).map((cap) => String(cap).toUpperCase()));
  return capDrop.has('ALL') && DOCKER_SANDBOX_CAPS.every((cap) => capAdd.has(cap));
}

function dockerCreateArgs() {
  return [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--label',
    `toolplane.sandbox=${SANDBOX_ID}`,
    '--workdir',
    '/workspace',
    '--network',
    NETWORK,
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    ...DOCKER_SANDBOX_CAPS.flatMap((cap) => ['--cap-add', cap]),
    '-v',
    `${VOLUME}:/workspace`,
    IMAGE,
    'sleep',
    'infinity',
  ];
}

async function createDockerContainer() {
  const created = await run('docker', dockerCreateArgs(), { env: dockerEnv(), timeoutMs: 120_000 });
  if (created.exitCode !== 0) throw new Error(created.stderr || `docker run failed (${created.exitCode})`);
}

async function ensureDockerContainer() {
  const info = await dockerInspectJson();
  if (info) {
    if (!hasExpectedDockerSandboxCaps(info)) {
      const removed = await run('docker', ['rm', '-f', CONTAINER], { env: dockerEnv(), timeoutMs: 30_000 });
      if (removed.exitCode !== 0) throw new Error(removed.stderr || `docker rm failed (${removed.exitCode})`);
      await createDockerContainer();
      return;
    }
    if (info.State?.Running === true) return;
    const started = await run('docker', ['start', CONTAINER], { env: dockerEnv(), timeoutMs: 30_000 });
    if (started.exitCode !== 0) throw new Error(started.stderr || `docker start failed (${started.exitCode})`);
    return;
  }

  await createDockerContainer();
}

async function ensureRuntime() {
  if (KIND === 'connector') {
    await connectorRequest('ping', {}, 10_000);
    return;
  }
  await ensureDockerContainer();
}

function workspacePath(raw) {
  const rel = safeRel(raw);
  if (rel === null) return null;
  return `/workspace${rel ? `/${rel}` : ''}`;
}

async function dockerShell({ command, cwd = '.', stdin = '', timeoutMs }) {
  const rel = safeRel(cwd);
  if (rel === null) return textResult('Invalid cwd.', true);
  const workdir = `/workspace${rel ? `/${rel}` : ''}`;
  const result = await run(
    'docker',
    ['exec', '-i', '-w', workdir, CONTAINER, 'sh', '-lc', String(command ?? '')],
    { env: dockerEnv(), stdin, timeoutMs },
  );
  return textResult(result, result.exitCode !== 0 || result.timedOut);
}

async function listDir(args = {}) {
  if (KIND === 'connector') {
    return connectorTool('list_dir', args, 10_000);
  }
  const p = workspacePath(args.path ?? '.');
  if (!p) return textResult('Invalid path.', true);
  const result = await run(
    'docker',
    ['exec', CONTAINER, 'sh', '-lc', `find ${shQuote(p)} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\n' | sort`],
    { env: dockerEnv() },
  );
  if (result.exitCode !== 0) return textResult(result, true);
  const entries = result.stdout.trim()
    ? result.stdout.trim().split('\n').map((line) => {
        const [name, kind, size] = line.split('\t');
        return { name, type: kind === 'd' ? 'dir' : 'file', size: Number(size) || null };
      })
    : [];
  return textResult({ path: safeRel(args.path ?? '.') || '.', entries, stderr: result.stderr });
}

async function readSandboxFile(args = {}) {
  if (KIND === 'connector') {
    return connectorTool('read_file', args, 10_000);
  }
  const p = workspacePath(args.path);
  if (!p) return textResult('Invalid path.', true);
  const result = await run('docker', ['exec', CONTAINER, 'cat', p], { env: dockerEnv() });
  return textResult({ path: safeRel(args.path), content: truncate(result.stdout), stderr: result.stderr }, result.exitCode !== 0);
}

async function writeSandboxFile(args = {}) {
  const rel = safeRel(args.path);
  if (!rel) return textResult('Invalid path.', true);
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE) return textResult('File content is too large.', true);
  if (KIND === 'connector') {
    return connectorTool('write_file', { ...args, path: rel, content }, 10_000);
  }
  const p = workspacePath(rel);
  const command = `mkdir -p ${shQuote(path.posix.dirname(p))} && cat > ${shQuote(p)}`;
  const result = await run('docker', ['exec', '-i', CONTAINER, 'sh', '-lc', command], {
    env: dockerEnv(),
    stdin: content,
  });
  return textResult({ path: rel, bytes: Buffer.byteLength(content, 'utf8'), stderr: result.stderr }, result.exitCode !== 0);
}

const terminalSessions = new Map();

function pushTerminalEvent(session, event, value) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  session.buffer.push(payload);
  if (session.buffer.length > MAX_TERMINAL_BUFFER) session.buffer.shift();
  for (const stream of session.streams) stream.write(payload);
}

function terminalEnv() {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
  };
}

function createTerminal(cols = 80, rows = 24) {
  const id = randomUUID();
  const safeCols = Math.min(Math.max(Number(cols) || 80, 20), 240);
  const safeRows = Math.min(Math.max(Number(rows) || 24, 6), 80);
  const term = pty.spawn('docker', [
    'exec',
    '-it',
    '-w',
    '/workspace',
    CONTAINER,
    'sh',
    '-lc',
    'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh; fi',
  ], {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd: process.cwd(),
    env: { ...dockerEnv(), ...terminalEnv() },
  });
  const session = {
    id,
    term,
    streams: new Set(),
    buffer: [],
    exitCode: null,
  };
  terminalSessions.set(id, session);
  term.onData((data) => pushTerminalEvent(session, 'data', { data }));
  term.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode;
    pushTerminalEvent(session, 'exit', { exitCode, signal });
    setTimeout(() => {
      terminalSessions.delete(id);
      for (const stream of session.streams) stream.end();
    }, 3000).unref();
  });
  return session;
}

async function pipeConnectorStream(upstream, req, res) {
  if (!upstream.body) {
    sendJson(res, 502, { error: 'terminal stream unavailable' });
    return;
  }
  res.writeHead(upstream.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const reader = upstream.body.getReader();
  req.on('close', () => {
    void reader.cancel().catch(() => null);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function proxyConnectorTerminal(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/terminal/session') {
    const body = await readBody(req).catch(() => '{}');
    const upstream = await connectorFetch(`/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/terminal/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body || '{}',
      signal: AbortSignal.timeout(10_000),
    });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  const match = /^\/terminal\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return false;
  const [, sessionId, action] = match;
  const basePath = `/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/terminal/session/${encodeURIComponent(sessionId)}`;

  if (req.method === 'GET' && action === 'stream') {
    const upstream = await connectorFetch(`${basePath}/stream`, { headers: { accept: 'text/event-stream' } });
    await pipeConnectorStream(upstream, req, res);
    return true;
  }

  if (req.method === 'POST' && (action === 'input' || action === 'resize')) {
    const body = await readBody(req).catch(() => '{}');
    const upstream = await connectorFetch(`${basePath}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body || '{}',
      signal: AbortSignal.timeout(10_000),
    });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  if (req.method === 'DELETE' && !action) {
    const upstream = await connectorFetch(basePath, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

function getTerminalSession(id, res) {
  const session = terminalSessions.get(id);
  if (!session) {
    sendJson(res, 404, { error: 'terminal session not found' });
    return null;
  }
  return session;
}

async function handleTerminal(req, res) {
  if (KIND === 'connector') return proxyConnectorTerminal(req, res);

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/terminal/session') {
    const body = await readJson(req).catch(() => ({}));
    const session = createTerminal(body.cols, body.rows);
    sendJson(res, 201, { id: session.id });
    return true;
  }

  const match = /^\/terminal\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return false;
  const [, sessionId, action] = match;
  const session = getTerminalSession(sessionId, res);
  if (!session) return true;

  if (req.method === 'GET' && action === 'stream') {
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
    return true;
  }

  if (req.method === 'POST' && action === 'input') {
    const body = await readJson(req).catch(() => ({}));
    session.term.write(String(body.data ?? '').slice(0, MAX_WRITE));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && action === 'resize') {
    const body = await readJson(req).catch(() => ({}));
    const cols = Math.min(Math.max(Number(body.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(body.rows) || 24, 6), 80);
    session.term.resize(cols, rows);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'DELETE' && !action) {
    session.term.kill();
    terminalSessions.delete(sessionId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'sandbox_info':
      return textResult({
        id: SANDBOX_ID,
        name: NAME,
        kind: KIND,
        image: KIND === 'docker' ? IMAGE : null,
        container: KIND === 'docker' ? CONTAINER : null,
        volume: KIND === 'docker' ? VOLUME : null,
        connector: KIND === 'connector'
          ? {
              remoteRoot: CONNECTOR_REMOTE_ROOT,
              broker: CONNECTOR_BROKER_URL,
            }
          : null,
        workspace: KIND === 'docker' ? '/workspace' : CONNECTOR_REMOTE_ROOT,
      });
    case 'shell_exec':
      if (!args.command) return textResult('command is required.', true);
      return KIND === 'connector'
        ? connectorTool('shell_exec', args, Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), (result) => Boolean(result?.timedOut) || Number(result?.exitCode ?? 0) !== 0)
        : dockerShell(args);
    case 'list_dir':
      return listDir(args);
    case 'read_file':
      return readSandboxFile(args);
    case 'write_file':
      return writeSandboxFile(args);
    default:
      return null;
  }
}

function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return Promise.resolve(callTool(params?.name, params?.arguments)).then((result) =>
        result === null ? fail(-32602, `Unknown tool: ${params?.name}`) : ok(result),
      );
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: NAME, kind: KIND }));
    return;
  }
  try {
    if (await handleTerminal(req, res)) return;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  readBody(req)
    .then(async (body) => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const response = await handleRpc(parsed);
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    })
    .catch((error) => sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
});

const shutdown = () => {
  for (const session of terminalSessions.values()) session.term.kill();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
}, 2000).unref();

ensureRuntime()
  .then(() => {
    server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.stdout.write(`LISTENING ${port}\n`);
    });
  })
  .catch((error) => {
    process.stderr.write(`sandbox-mcp-server: startup failed: ${error.message}\n`);
    process.exit(1);
  });
