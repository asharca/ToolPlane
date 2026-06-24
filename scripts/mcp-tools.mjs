// Pure MCP tool definitions and JSON-RPC dispatch logic, shared between the
// runnable server (mcp-server.mjs) and unit tests. No I/O here.

export const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
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

export function textResult(text, isError = false) {
  const out = { content: [{ type: 'text', text: String(text) }] };
  if (isError) out.isError = true;
  return out;
}

// Execute a tool by name. Returns an MCP tool result, or null for an unknown
// tool (so the caller can emit a JSON-RPC error).
export function callTool(name, args = {}) {
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

// Build a JSON-RPC handler bound to a server identity. Returns a function that
// maps a JSON-RPC message to a response object, or null for notifications.
export function createRpcHandler({ name = 'mcp', version = '1.0.0' } = {}) {
  return function handleRpc(msg) {
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
          serverInfo: { name, version },
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
  };
}
