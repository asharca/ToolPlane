import { describe, it, expect, vi } from 'vitest';
import { toolKey, buildToolSet, type ToolDeps } from '@/lib/agents/tools';

describe('toolKey', () => {
  it('uses a stable sanitized key with hashed deployment and tool identity', () => {
    expect(toolKey('abcd1234efgh', 'do/thing')).toMatch(/^d_[0-9a-f]{12}__do_thing_[0-9a-f]{8}$/);
  });

  it('does not collide for shared id prefixes or similarly sanitized tool names', () => {
    expect(toolKey('sameprefix-aaaaaaaa', 'echo')).not.toBe(toolKey('sameprefix-bbbbbbbb', 'echo'));
    expect(toolKey('dep', 'do/thing')).not.toBe(toolKey('dep', 'do_thing'));
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
      loadMcpToolPolicies: vi.fn(async () => new Map([
        ['run1', { mode: 'all' as const, allowedTools: [] }],
        ['stopped2', { mode: 'all' as const, allowedTools: [] }],
      ])),
    };

    const set = await buildToolSet(['run1', 'stopped2'], 'ws1', deps);
    const key = toolKey('run1', 'echo');
    const keys = Object.keys(set);
    expect(keys).toEqual([key]);
    expect(deps.listMcpTools).not.toHaveBeenCalledWith('stopped2');
    expect(deps.loadMcpToolPolicies).toHaveBeenCalledWith(['run1', 'stopped2'], 'ws1');

    const out = await set[key].execute!({ msg: 'hi' }, { toolCallId: 't', messages: [] } as never);
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
      loadMcpToolPolicies: async () => new Map([
        ['run1', { mode: 'all', allowedTools: [] }],
      ]),
    };
    const set = await buildToolSet(['run1'], 'ws1', deps);
    const out = await set[toolKey('run1', 'echo')].execute!({}, { toolCallId: 't', messages: [] } as never);
    expect(out).toMatchObject({ error: expect.stringContaining('not reachable') });
    expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
  });

  it('exposes only exact allowlisted tools and treats an empty allowlist as none', async () => {
    const listMcpTools = vi.fn(async () => [
      { name: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'write', inputSchema: { type: 'object', properties: {} } },
    ]);
    const deps: ToolDeps = {
      liveStatus: () => 'running',
      listMcpTools,
      mcpRpc: vi.fn(async () => ({})),
      logRequest: vi.fn(async () => {}),
      loadMcpToolPolicies: async () => new Map([
        ['selected', { mode: 'allowlist', allowedTools: ['read', 'READ'] }],
        ['none', { mode: 'allowlist', allowedTools: [] }],
      ]),
    };

    const set = await buildToolSet(['selected', 'none'], 'ws1', deps);

    expect(Object.keys(set)).toEqual([toolKey('selected', 'read')]);
    expect(listMcpTools).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a deployment has no workspace-scoped policy row', async () => {
    const liveStatus = vi.fn(() => 'running');
    const listMcpTools = vi.fn(async () => [{ name: 'secret' }]);
    const deps: ToolDeps = {
      liveStatus,
      listMcpTools,
      mcpRpc: vi.fn(async () => ({})),
      logRequest: vi.fn(async () => {}),
      loadMcpToolPolicies: async () => new Map(),
    };

    await expect(buildToolSet(['foreign'], 'ws1', deps)).resolves.toEqual({});
    expect(liveStatus).not.toHaveBeenCalled();
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  it('rechecks policy at call time so a tool revoked during a turn cannot execute', async () => {
    let policyLoad = 0;
    const mcpRpc = vi.fn(async () => ({}));
    const logRequest = vi.fn(async () => {});
    const deps: ToolDeps = {
      liveStatus: () => 'running',
      listMcpTools: async () => [{ name: 'write' }],
      mcpRpc,
      logRequest,
      loadMcpToolPolicies: async () => {
        policyLoad += 1;
        return new Map([[
          'run1',
          policyLoad === 1
            ? { mode: 'all' as const, allowedTools: [] }
            : { mode: 'allowlist' as const, allowedTools: [] },
        ]]);
      },
    };

    const set = await buildToolSet(['run1'], 'ws1', deps);
    const out = await set[toolKey('run1', 'write')].execute!(
      { value: 'x' },
      { toolCallId: 't', messages: [] } as never,
    );

    expect(out).toEqual({ error: 'MCP tool write is not exposed to AI.' });
    expect(mcpRpc).not.toHaveBeenCalled();
    expect(logRequest).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
