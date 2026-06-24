// A real, protocol-compliant MCP server spawned per deployment by the
// supervisor. It speaks JSON-RPC 2.0 over HTTP (the MCP Streamable HTTP
// transport surface). Tool logic lives in mcp-tools.mjs so it can be unit
// tested. This file is just the HTTP/process shell.
import http from 'node:http';
import { TOOLS, PROTOCOL_VERSION, createRpcHandler } from './mcp-tools.mjs';

const NAME = process.env.MCP_NAME || 'mcp';
const VERSION = '1.0.0';
const startedAt = new Date().toISOString();
const handleRpc = createRpcHandler({ name: NAME, version: VERSION });

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

// Orphan watchdog: if the supervising parent dies, our ppid is reparented to
// init/launchd. Self-terminate so processes don't leak across dev restarts.
const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
}, 2000).unref();
