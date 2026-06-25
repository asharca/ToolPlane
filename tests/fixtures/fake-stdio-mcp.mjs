// tests/fixtures/fake-stdio-mcp.mjs
// Minimal newline-delimited JSON-RPC MCP server over stdio. Lets us test the
// bridge without any network access (no real npx download).
let buffer = '';
process.stdin.on('data', (chunk) => {
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
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method } = msg;
  if (id === undefined || id === null) return; // notification, no reply
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: [{ name: 'ping_tool', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }] },
    });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}
