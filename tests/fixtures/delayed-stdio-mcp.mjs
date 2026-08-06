// A controllably slow stdio MCP. It emits stderr progress while initialize is
// pending so the bridge integration test can exercise the startup watchdog
// without Docker or a package download.
function numberArg(name, fallback) {
  const prefix = '--' + name + '=';
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const value = Number(arg?.slice(prefix.length));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const delayMs = numberArg('delay-ms', 160);
const progressMs = numberArg('progress-ms', 25);
let buffer = '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function initialize(id) {
  const progress = progressMs > 0
    ? setInterval(() => process.stderr.write('delayed MCP is still initializing\n'), progressMs)
    : null;
  setTimeout(() => {
    if (progress) clearInterval(progress);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'delayed-fake', version: '1.0.0' },
      },
    });
  }, delayMs);
}

function handle(msg) {
  const { id, method } = msg;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    initialize(id);
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: [{ name: 'ping_tool', inputSchema: { type: 'object', properties: {} } }] },
    });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore malformed input, matching the simple fake fixture.
    }
  }
});
