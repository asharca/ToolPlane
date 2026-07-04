// scripts/mcp-stdio-bridge.mjs
// Bridges a stdio MCP server (spawned from MCP_COMMAND/MCP_ARGS) to the HTTP
// JSON-RPC surface the rest of the app speaks. Holds ONE persistent stdio
// connection, performs the MCP initialize handshake once, then forwards each
// incoming HTTP JSON-RPC request onto that connection (remapping ids so
// concurrent callers can't collide). Prints `LISTENING <port>` once ready,
// mirroring scripts/mcp-server.mjs so the supervisor/gateway are unchanged.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { filterEnv } from './bridge-env.mjs';

const NAME = process.env.MCP_NAME || 'mcp';
const COMMAND = process.env.MCP_COMMAND;
const ARGS = JSON.parse(process.env.MCP_ARGS || '[]');
const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 70000;

if (!COMMAND) {
  process.stderr.write('mcp-stdio-bridge: MCP_COMMAND is required\n');
  process.exit(1);
}

// COMMAND is always `docker`; give the CLI only the minimal allowlisted env
// (PATH + DOCKER_* settings). The MCP's own env is inside ARGS as `-e` flags, so
// the app's secrets never reach the CLI process or the container.
const childEnv = filterEnv(process.env);

const child = spawn(COMMAND, ARGS, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
child.on('error', (err) => {
  process.stderr.write(`mcp-stdio-bridge: spawn failed: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => {
  process.stderr.write(`mcp-stdio-bridge: child exited (${code})\n`);
  process.exit(code ?? 1);
});
child.stderr.on('data', (b) => process.stderr.write(b));

// --- persistent stdio JSON-RPC plumbing ---
let nextId = 1;
const pending = new Map(); // ourId -> resolve(msg)
let buffer = '';
let initResult = null;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON noise on stdout
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function callChild(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notifyChild(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function handshake() {
  const reply = await callChild('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'toolplane-bridge', version: '1.0.0' },
  });
  initResult = reply.result ?? {};
  notifyChild('notifications/initialized', {});
}

// --- HTTP surface (mirrors scripts/mcp-server.mjs) ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: NAME }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let msg;
    try {
      msg = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    // Notifications: nothing to forward, no response body.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    // The child is already initialized; answer initialize from our stored result.
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: initResult }));
      return;
    }
    try {
      const reply = await callChild(msg.method, msg.params);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...reply, id: msg.id })); // restore the caller's original id
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String((err && err.message) || err) } }),
      );
    }
  });
});

const shutdown = () => {
  try {
    child.kill('SIGTERM');
  } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Orphan watchdog: self-terminate if the supervising parent dies.
const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
}, 2000).unref();

// Bring the child up, then start listening (so "running" means truly ready).
handshake()
  .then(() => {
    server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.stdout.write(`LISTENING ${port}\n`);
    });
  })
  .catch((err) => {
    process.stderr.write(`mcp-stdio-bridge: handshake failed: ${err.message}\n`);
    process.exit(1);
  });
