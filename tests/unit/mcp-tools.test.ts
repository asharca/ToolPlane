import { describe, it, expect } from 'vitest';
// .mjs module without types — load with permissive signatures for tests.
import * as mcp from '../../scripts/mcp-tools.mjs';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} | null;
type RpcResponse = {
  result: {
    serverInfo?: { name: string; version: string };
    protocolVersion?: string;
    tools?: unknown[];
    content?: Array<{ type?: string; text: string }>;
  };
  error?: unknown;
};

const callTool = mcp.callTool as (
  name: string,
  args?: Record<string, unknown>,
) => ToolResult;
const createRpcHandler = mcp.createRpcHandler as (
  opts?: { name?: string; version?: string },
) => (msg: unknown) => RpcResponse;
const TOOLS = mcp.TOOLS as Array<{ name: string }>;

describe('MCP tool dispatch', () => {
  it('exposes the expected tool catalog', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'echo',
      'add',
      'current_time',
      'random_number',
      'uppercase',
    ]);
  });

  it('echo returns the message', () => {
    expect(callTool('echo', { message: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('add sums numbers and flags non-numeric input', () => {
    expect(callTool('add', { a: 2, b: 3 }).content[0].text).toBe('5');
    expect(callTool('add', { a: 'x', b: 3 }).isError).toBe(true);
  });

  it('uppercase upper-cases text', () => {
    expect(callTool('uppercase', { text: 'abc' }).content[0].text).toBe('ABC');
  });

  it('random_number stays within bounds', () => {
    for (let i = 0; i < 25; i += 1) {
      const n = Number(callTool('random_number', { min: 5, max: 7 }).content[0].text);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it('returns null for an unknown tool', () => {
    expect(callTool('nope', {})).toBeNull();
  });
});

describe('createRpcHandler', () => {
  const handle = createRpcHandler({ name: 'TestSrv', version: '9.9.9' });

  it('answers initialize with serverInfo', () => {
    const res = handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.result.serverInfo).toEqual({ name: 'TestSrv', version: '9.9.9' });
    expect(res.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists tools', () => {
    const res = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools).toHaveLength(5);
  });

  it('calls a tool', () => {
    const res = handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 10, b: 20 } },
    });
    expect(res.result.content[0].text).toBe('30');
  });

  it('errors on unknown tool and unknown method', () => {
    const unknownTool = handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ghost' },
    });
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = handle({ jsonrpc: '2.0', id: 5, method: 'foo/bar' });
    expect(unknownMethod.error.code).toBe(-32601);
  });

  it('treats notifications (no id) as fire-and-forget', () => {
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});
