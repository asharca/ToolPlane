// A minimal, real MCP-style server process spawned per deployment by the
// supervisor. It binds an ephemeral port, prints it so the supervisor can
// learn where it is, and answers /health. Killing the process is what makes
// a deployment's status flip to stopped/error.
import http from 'node:http';

const name = process.env.MCP_NAME || 'mcp';
const startedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name, startedAt }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name, message: 'mcp stub server', path: req.url }));
});

server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`LISTENING ${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
