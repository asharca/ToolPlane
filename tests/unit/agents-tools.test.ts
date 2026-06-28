import { describe, it, expect, vi } from 'vitest';
import { toolKey, buildToolSet, type ToolDeps } from '@/lib/agents/tools';

describe('toolKey', () => {
  it('prefixes with a sanitized deployment id and sanitizes the tool name', () => {
    expect(toolKey('abcd1234efgh', 'do/thing')).toBe('abcd1234__do_thing');
  });
});

describe('buildToolSet', () => {
  it('builds tools only for running deployments and proxies execute to mcpRpc', async () => {
    const logRequest = vi.fn(async () => {});
    const deps: ToolDeps = {
      liveStatus: (id) => (id === 'run1' ? 'running' : 'stopped'),
      listMcpTools: vi.fn(async (id) =>
        id === 'run1' ? [{ name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } }] : [],
      ),
      mcpRpc: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      logRequest,
    };

    const set = await buildToolSet(['run1', 'stopped2'], 'ws1', deps);
    const keys = Object.keys(set);
    expect(keys).toEqual(['run1__echo']);
    expect(deps.listMcpTools).not.toHaveBeenCalledWith('stopped2');

    const out = await set['run1__echo'].execute!({ msg: 'hi' }, { toolCallId: 't', messages: [] } as never);
    expect(deps.mcpRpc).toHaveBeenCalledWith('run1', 'tools/call', { name: 'echo', arguments: { msg: 'hi' } });
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });

    // The agent tool call is recorded for observability (it bypasses the gateway).
    expect(logRequest).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        deploymentId: 'run1',
        statusCode: 200,
        path: '/mcp/run1/rpc#tools/call:echo',
      }),
    );
  });

  it('returns an error result and logs 502 when the MCP process is unreachable', async () => {
    const logRequest = vi.fn(async () => {});
    const deps: ToolDeps = {
      liveStatus: () => 'running',
      listMcpTools: async () => [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      mcpRpc: async () => null,
      logRequest,
    };
    const set = await buildToolSet(['run1'], 'ws1', deps);
    const out = await set['run1__echo'].execute!({}, { toolCallId: 't', messages: [] } as never);
    expect(out).toMatchObject({ error: expect.stringContaining('not reachable') });
    expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
  });
});
