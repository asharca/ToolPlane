import { describe, it, expect } from 'vitest';
// .mjs module without types — load with permissive signatures for tests.
import * as mcp from '../../scripts/mcp-tools.mjs';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} | null;
type RpcResponse = {
  result?: {
    serverInfo?: { name: string; version: string };
    protocolVersion?: string;
    capabilities?: { prompts?: { listChanged?: boolean } };
    tools?: unknown[];
    prompts?: unknown[];
    messages?: Array<{
      role?: string;
      content?: { type?: string; text?: string };
    }>;
    content?: Array<{ type?: string; text: string }>;
  };
  error?: { code: number; message?: string };
};

const callTool = mcp.callTool as (
  name: string,
  args?: Record<string, unknown>,
) => ToolResult;
const createRpcHandler = mcp.createRpcHandler as (
  opts?: { name?: string; version?: string },
) => (msg: unknown) => RpcResponse | null;
const TOOLS = mcp.TOOLS as Array<{ name: string }>;
const PROMPTS = mcp.PROMPTS as Array<{ name: string }>;
const getPrompt = mcp.getPrompt as (
  name: string,
  args?: Record<string, unknown>,
) => { messages: Array<{ content: { text: string } }> } | null;

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
    expect(callTool('add', { a: 2, b: 3 })?.content[0].text).toBe('5');
    expect(callTool('add', { a: 'x', b: 3 })?.isError).toBe(true);
  });

  it('uppercase upper-cases text', () => {
    expect(callTool('uppercase', { text: 'abc' })?.content[0].text).toBe('ABC');
  });

  it('random_number stays within bounds', () => {
    for (let i = 0; i < 25; i += 1) {
      const n = Number(callTool('random_number', { min: 5, max: 7 })?.content[0].text);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it('returns null for an unknown tool', () => {
    expect(callTool('nope', {})).toBeNull();
  });
});

describe('MCP prompt dispatch', () => {
  it('exposes the expected prompt catalog', () => {
    expect(PROMPTS.map((prompt) => prompt.name)).toEqual([
      'summarize_text',
      'rewrite_for_audience',
    ]);
  });

  it('renders a prompt with the supplied arguments', () => {
    expect(getPrompt('rewrite_for_audience', {
      text: 'Ship it',
      audience: 'a product manager',
    })?.messages[0].content.text).toBe(
      'Rewrite the following text for a product manager:\n\nShip it',
    );
    expect(getPrompt('nope')).toBeNull();
  });
});

describe('createRpcHandler', () => {
  const handle = createRpcHandler({ name: 'TestSrv', version: '9.9.9' });

  it('answers initialize with serverInfo', () => {
    const res = handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res?.result?.serverInfo).toEqual({ name: 'TestSrv', version: '9.9.9' });
    expect(res?.result?.protocolVersion).toBe('2025-06-18');
    expect(res?.result?.capabilities?.prompts).toEqual({ listChanged: false });
  });

  it('lists tools', () => {
    const res = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res?.result?.tools).toHaveLength(5);
  });

  it('calls a tool', () => {
    const res = handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 10, b: 20 } },
    });
    expect(res?.result?.content?.[0]?.text).toBe('30');
  });

  it('lists and resolves prompts', () => {
    const listed = handle({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
    expect(listed?.result?.prompts).toHaveLength(2);

    const resolved = handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'prompts/get',
      params: { name: 'summarize_text', arguments: { text: 'A long update' } },
    });
    expect(resolved?.result?.messages?.[0]?.content?.text).toContain('A long update');
  });

  it('errors on unknown tool and unknown method', () => {
    const unknownTool = handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ghost' },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
    const unknownPrompt = handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'prompts/get',
      params: { name: 'ghost' },
    });
    expect(unknownPrompt?.error?.code).toBe(-32602);
    const unknownMethod = handle({ jsonrpc: '2.0', id: 6, method: 'foo/bar' });
    expect(unknownMethod?.error?.code).toBe(-32601);
  });

  it('treats notifications (no id) as fire-and-forget', () => {
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});
