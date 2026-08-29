import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mcpRpc: vi.fn() }));

vi.mock('@/lib/process/mcp-client', () => ({ mcpRpc: mocks.mcpRpc }));

import {
  listMcpToolsViaSandbox,
  mcpRpcViaSandbox,
  SandboxMcpAuthenticationError,
} from '@/lib/process/sandbox-mcp-client';

const remote = {
  kind: 'remote' as const,
  name: 'Remote',
  url: 'https://mcp.example.com/mcp',
  transport: 'streamable-http' as const,
  headers: { authorization: 'Bearer top-secret' },
  timeoutMs: 30_000,
};

function execution(result: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify({ result }),
      }),
    }],
  };
}

function executionError(error: string) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify({ error }),
      }),
    }],
  };
}

describe('sandbox MCP client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the remote MCP request through sandbox process_exec without argv secrets', async () => {
    mocks.mcpRpc.mockResolvedValue(execution({ content: [{ type: 'text', text: 'ok' }] }));

    await expect(mcpRpcViaSandbox('sandbox-deployment', remote, 'tools/call', {
      name: 'search',
      arguments: { query: 'test' },
    })).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });

    expect(mocks.mcpRpc).toHaveBeenCalledWith(
      'sandbox-deployment',
      'tools/call',
      expect.objectContaining({
        name: 'process_exec',
        arguments: expect.objectContaining({ runtime: 'node', args: ['-e', expect.any(String)] }),
      }),
      35_000,
      { maxRequestBytes: 1_000_000, maxResponseBytes: 256_000 },
    );
    const call = mocks.mcpRpc.mock.calls[0][2] as {
      arguments: { args: string[]; stdin: string };
    };
    expect(JSON.stringify(call.arguments.args)).not.toContain('top-secret');
    expect(call.arguments.stdin).toContain('top-secret');
    expect(call.arguments.stdin).toContain("c.transport==='sse'?await legacy():await streamable()");
  });

  it('collects and validates paginated tool schemas', async () => {
    mocks.mcpRpc
      .mockResolvedValueOnce(execution({
        tools: [{ name: 'first', inputSchema: { type: 'object' } }],
        nextCursor: 'page-2',
      }))
      .mockResolvedValueOnce(execution({
        tools: [{ name: 'second', inputSchema: { type: 'object' } }],
      }));

    await expect(listMcpToolsViaSandbox('sandbox-deployment', remote)).resolves.toEqual([
      { name: 'first', inputSchema: { type: 'object' } },
      { name: 'second', inputSchema: { type: 'object' } },
    ]);
    const secondStdin = (mocks.mcpRpc.mock.calls[1][2] as {
      arguments: { stdin: string };
    }).arguments.stdin;
    expect(JSON.parse(secondStdin.slice(0, secondStdin.indexOf('\n')))).toMatchObject({
      method: 'tools/list',
      params: { cursor: 'page-2' },
    });
  });

  it('does not accept a failed sandbox process as an MCP result', async () => {
    mocks.mcpRpc.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ exitCode: 1, stdout: '' }) }],
      isError: true,
    });
    await expect(mcpRpcViaSandbox('sandbox-deployment', remote, 'tools/list')).resolves.toBeNull();
  });

  it('surfaces only the controlled authentication failure code', async () => {
    mocks.mcpRpc.mockResolvedValue(executionError('authentication_failed'));

    await expect(mcpRpcViaSandbox('sandbox-deployment', remote, 'tools/list'))
      .rejects.toBeInstanceOf(SandboxMcpAuthenticationError);

    const stdin = (mocks.mcpRpc.mock.calls[0][2] as { arguments: { stdin: string } }).arguments.stdin;
    expect(stdin).toContain("'authentication_failed':'connection_failed'");
    expect(stdin).toContain("Remote MCP SSE connection failed ('+r.status+')");
  });

  it('rejects a truncated over-limit sandbox response instead of persisting partial JSON', async () => {
    mocks.mcpRpc.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ exitCode: 0, timedOut: false, stdout: '{"result":{"tools":[' }),
      }],
    });
    await expect(listMcpToolsViaSandbox('sandbox-deployment', remote)).resolves.toBeNull();
    const stdin = (mocks.mcpRpc.mock.calls[0][2] as { arguments: { stdin: string } }).arguments.stdin;
    expect(stdin).toContain("throw Error('Remote MCP response too large')");
  });
});
