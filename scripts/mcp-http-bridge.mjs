// Keeps remote MCP credentials behind ToolPlane's loopback JSON-RPC surface.
// The official SDK owns MCP initialization, sessions, Streamable HTTP and SSE.
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

const NAME = process.env.MCP_NAME || 'remote-mcp';
const RUNTIME_EVENT_TOKEN = (process.env.MCP_RUNTIME_EVENT_TOKEN || '').trim();
let rawConfig = process.env.MCP_REMOTE_CONFIG || '';
delete process.env.MCP_REMOTE_CONFIG;

function invalidConfig(message) {
  throw new Error(`invalid remote MCP configuration: ${message}`);
}

function parseConfig() {
  let value;
  try {
    value = JSON.parse(rawConfig);
  } catch {
    invalidConfig('malformed JSON');
  } finally {
    rawConfig = '';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidConfig('expected an object');

  let url;
  try {
    url = new URL(value.url);
  } catch {
    invalidConfig('invalid URL');
  }
  if (url.protocol !== 'https:') invalidConfig('URL must use HTTPS');
  if (url.username || url.password || url.port || url.search || url.hash) {
    invalidConfig('URL cannot contain credentials, a custom port, query parameters, or a fragment');
  }
  if (value.transport !== 'streamable-http' && value.transport !== 'sse') {
    invalidConfig('unsupported transport');
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 600_000) {
    invalidConfig('timeout is out of range');
  }
  if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers)) {
    invalidConfig('headers must be an object');
  }
  const headers = Object.create(null);
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== 'string' || headerValue.length > 8_192 || /[\r\n]/.test(headerValue)) {
      invalidConfig('invalid header value');
    }
    try {
      new Headers({ [name]: headerValue });
    } catch {
      invalidConfig('invalid header name');
    }
    headers[name] = headerValue;
  }
  return { url, transport: value.transport, timeoutMs: value.timeoutMs, headers };
}

const CONFIG = parseConfig();
const secretValues = [...new Set(Object.values(CONFIG.headers).flatMap((value) => {
  const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  return match ? [value, match[1]] : [value];
}).filter(Boolean))].sort((a, b) => b.length - a.length);

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.split(CONFIG.url.href).join('[remote MCP endpoint]');
  for (const secret of secretValues) {
    message = message.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) message = message.split(encoded).join('[REDACTED]');
  }
  return message
    .replace(/(authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
    .slice(0, 1_000);
}

function runtimePhase(phase, message) {
  const event = { type: 'phase', phase };
  if (RUNTIME_EVENT_TOKEN) event.token = RUNTIME_EVENT_TOKEN;
  if (message) event.message = message;
  process.stderr.write('[toolplane-runtime] ' + JSON.stringify(event) + '\n');
}

function blockedIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function blockedIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted && normalized.startsWith('::')) return blockedIpv4(dotted);
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return normalized === '::'
    || normalized === '::1'
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || normalized.startsWith('64:ff9b:')
    || normalized.startsWith('100:')
    || normalized.startsWith('2001:db8:');
}

function blockedIp(address) {
  const family = isIP(address);
  return family === 4 ? blockedIpv4(address) : family === 6 ? blockedIpv6(address) : true;
}

async function assertPublicUrl(url, allowQuery = false) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!allowQuery && url.search) || url.hash) {
    throw new Error('Remote MCP endpoint is not allowed.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Remote MCP endpoint is not allowed.');
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => blockedIp(address))) {
    throw new Error('Remote MCP endpoint resolved to a non-public address.');
  }
}

async function safeFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== CONFIG.url.origin) throw new Error('Remote MCP endpoint is not allowed.');
  // Legacy SSE servers announce a same-origin POST endpoint with a session ID
  // in its query string. The configured URL itself remains query-free.
  await assertPublicUrl(url, CONFIG.transport === 'sse');
  return fetch(input, { ...init, redirect: 'error' });
}

const requestInit = { headers: CONFIG.headers, redirect: 'error' };
const transport = CONFIG.transport === 'sse'
  ? new SSEClientTransport(CONFIG.url, {
      requestInit,
      eventSourceInit: { fetch: safeFetch },
      fetch: safeFetch,
    })
  : new StreamableHTTPClientTransport(CONFIG.url, { requestInit, fetch: safeFetch });
const client = new Client({ name: 'toolplane-http-bridge', version: '1.0.0' }, { capabilities: {} });
let initResult = null;
let shuttingDown = false;

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
  req.on('data', (chunk) => {
    body += chunk;
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
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }));
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: initResult }));
      return;
    }
    try {
      const result = await client.request(
        { method: msg.method, ...(msg.params === undefined ? {} : { params: msg.params }) },
        ResultSchema,
        { timeout: CONFIG.timeoutMs },
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : -32000;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message: safeMessage(error) } }));
    }
  });
});

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await client.close();
  } catch {
    // The remote connection may already be gone.
  }
  process.exitCode = code;
}

process.once('SIGTERM', () => void shutdown(0));
process.once('SIGINT', () => void shutdown(0));

async function start() {
  try {
    runtimePhase('initializing', 'Connecting to remote MCP.');
    await assertPublicUrl(CONFIG.url);
    let timer;
    try {
      await Promise.race([
        client.connect(transport, { timeout: CONFIG.timeoutMs }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Remote MCP connection timed out.')), CONFIG.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (shuttingDown) return;
    initResult = {
      protocolVersion: transport.protocolVersion ?? '2025-06-18',
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? { name: NAME, version: 'unknown' },
      ...(client.getInstructions() ? { instructions: client.getInstructions() } : {}),
    };
    server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
      if (shuttingDown) return;
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      runtimePhase('ready');
      process.stdout.write(`LISTENING ${port}\n`);
    });
  } catch (error) {
    const message = safeMessage(error);
    runtimePhase('error', message);
    process.stderr.write(`mcp-http-bridge: startup failed: ${message}\n`);
    await shutdown(1);
  }
}

void start();
