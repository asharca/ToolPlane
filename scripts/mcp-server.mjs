// A real, protocol-compliant MCP server spawned per deployment by the
// supervisor. It speaks JSON-RPC 2.0 over HTTP (the MCP Streamable HTTP
// transport surface): initialize / tools/list / tools/call / ping. It binds
// an ephemeral port and prints `LISTENING <port>` so the supervisor can learn
// where it is, and answers GET /health for liveness checks.
import http from 'node:http';

const NAME = process.env.MCP_NAME || 'mcp';
const VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const startedAt = new Date().toISOString();

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo back' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'current_time',
    description: 'Return the current server time as an ISO 8601 string.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'random_number',
    description: 'Return a random integer between min and max (inclusive).',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'number', description: 'Lower bound (default 0)' },
        max: { type: 'number', description: 'Upper bound (default 100)' },
      },
    },
  },
  {
    name: 'uppercase',
    description: 'Convert the given text to upper case.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function textResult(text, isError = false) {
  const out = { content: [{ type: 'text', text: String(text) }] };
  if (isError) out.isError = true;
  return out;
}

function callTool(name, args = {}) {
  switch (name) {
    case 'echo':
      return textResult(args.message ?? '');
    case 'add': {
      const a = Number(args.a);
      const b = Number(args.b);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        return textResult('add requires numeric "a" and "b"', true);
      }
      return textResult(a + b);
    }
    case 'current_time':
      return textResult(new Date().toISOString());
    case 'random_number': {
      const min = Math.ceil(Number(args.min ?? 0));
      const max = Math.floor(Number(args.max ?? 100));
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      return textResult(Math.floor(Math.random() * (hi - lo + 1)) + lo);
    }
    case 'uppercase':
      return textResult(String(args.text ?? '').toUpperCase());
    default:
      return null;
  }
}

function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result) =>
    isNotification ? null : { jsonrpc: '2.0', id, result };
  const fail = (code, message) =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } };

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
    case 'tools/call': {
      const result = callTool(params?.name, params?.arguments);
      if (result === null) return fail(-32602, `Unknown tool: ${params?.name}`);
      return ok(result);
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', name: NAME, startedAt, tools: TOOLS.length }),
    );
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: NAME,
        protocol: 'mcp',
        protocolVersion: PROTOCOL_VERSION,
        version: VERSION,
        tools: TOOLS.map((t) => t.name),
      }),
    );
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        return;
      }
      if (Array.isArray(parsed)) {
        const responses = parsed.map(handleRpc).filter((r) => r !== null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responses));
        return;
      }
      const response = handleRpc(parsed);
      if (response === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    return;
  }
  res.writeHead(405);
  res.end();
});

server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`LISTENING ${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Orphan watchdog: if our supervising parent dies, ppid is reparented to
// init/launchd (becomes 1 or simply changes). Self-terminate so stub
// processes don't leak across Next dev restarts.
const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
}, 2000).unref();
