// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleSandboxMcp } from '@/lib/sandboxes/mcp-http';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';

const mocks = vi.hoisted(() => ({
  grant: vi.fn(), rpc: vi.fn(), tools: vi.fn(), begin: vi.fn(), release: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/sandboxes/mcp-access', () => ({
  resolveSandboxMcpGrant: mocks.grant,
  sandboxBearer: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
}));
vi.mock('@/lib/process/mcp-client', () => ({ mcpRpc: mocks.rpc, listMcpTools: mocks.tools }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: (_id: string, status: string) => status }));
vi.mock('@/lib/workspace/operation-gate', () => ({ beginWorkspaceOperation: mocks.begin }));
vi.mock('@/lib/observability/context', () => ({
  enrichLogContext: () => {},
  withLogContext: (_context: unknown, operation: () => unknown) => operation(),
}));

function makeGrant() {
  const id = randomUUID();
  return {
    id: `grant-${id}`, userId: 'boundary-user',
    allowedTools: ['sandbox_info', 'read_file', 'shell_exec', 'process_exec', 'write_file', 'delete_file'],
    sandbox: {
      id: `sandbox-${id}`, workspaceId: 'boundary-workspace', deploymentId: 'boundary-deployment',
      deployment: { status: 'running', mcpToolExposure: 'all', mcpAllowedTools: [] as string[] },
    },
  };
}
let grant: ReturnType<typeof makeGrant>;
const success = { content: [{ type: 'text', text: 'completed' }] };
const endpoint = () => `https://toolplane.test/api/v1/sandboxes/${grant.sandbox.id}/mcp`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOOLPLANE_PUBLIC_URL', 'https://toolplane.test');
  grant = makeGrant();
  mocks.grant.mockResolvedValue(grant);
  mocks.rpc.mockResolvedValue(success);
  mocks.begin.mockReturnValue(mocks.release);
  mocks.tools.mockResolvedValue([
    {
      name: 'sandbox_info', inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true },
      securitySchemes: [{ type: 'noauth' }],
      _meta: { privateRuntimeCredential: 'must-not-escape', securitySchemes: [{ type: 'noauth' }] },
    },
    { name: 'private_admin_api', inputSchema: { type: 'object', properties: {} } },
  ]);
});
afterEach(() => { vi.unstubAllEnvs(); });

// Keep the real SDK client, server, transport, schema validation and execution
// lease. Only external identity, runtime I/O and workspace admission are mocked.
async function withClient(operation: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'sandbox-boundary-test', version: '1.0.0' });
  const fetcher: typeof fetch = async (url, init) => handleSandboxMcp(new Request(url, init), grant.sandbox.id);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint()), {
    fetch: fetcher, requestInit: { headers: { authorization: 'Bearer boundary-test-token' } },
  });
  try {
    await client.connect(transport);
    await operation(client);
  } finally { await client.close(); }
}

describe('sandbox MCP transport failure boundaries', () => {
  it('dispatches once and retains the outer deadline and payload limits', async () => {
    await withClient(async (client) => {
      const args = { command: 'echo test', timeoutMs: 120_000 };
      const result = await client.callTool({ name: 'shell_exec', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('boundary-deployment', 'tools/call', {
        name: 'shell_exec', arguments: args,
      }, 180_000, { maxRequestBytes: 4_000_000, maxResponseBytes: 8_000_000 });
      expect(mocks.release).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['shell_exec', 'process_exec', 'write_file', 'delete_file'])(
    'keeps a lost %s reply uncertain without leaking diagnostics or retrying', async (name) => {
      mocks.rpc.mockRejectedValueOnce(new Error('timeout; Authorization: Bearer secret-runtime-token /private/key'));
      await withClient(async (client) => {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        const body = JSON.stringify(result);
        expect(body).toContain('may have executed');
        expect(body).toContain('inspect state before retrying');
        expect(body).not.toContain('No command was submitted');
        expect(body).not.toContain('secret-runtime-token');
        expect(body).not.toContain('/private/key');
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        expect(mocks.release).toHaveBeenCalledTimes(1);
        // A separate, deliberate inspection remains possible after the failed
        // mutation. This also exercises cleanup of the real execution lease.
        const inspection = await client.callTool({ name: 'sandbox_info', arguments: {} });
        expect(inspection.isError).not.toBe(true);
        expect(mocks.rpc).toHaveBeenCalledTimes(2);
        expect(mocks.rpc.mock.calls[1][2]).toEqual({ name: 'sandbox_info', arguments: {} });
        expect(mocks.release).toHaveBeenCalledTimes(2);
      });
    },
  );

  it('treats malformed runtime results as uncertain and releases the lease', async () => {
    mocks.rpc.mockResolvedValueOnce({ invalid: 'not a CallToolResult' });
    await withClient(async (client) => {
      const failed = await client.callTool({ name: 'write_file', arguments: {} });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain('may have executed');
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      const next = await client.callTool({ name: 'sandbox_info', arguments: {} });
      expect(next.isError).not.toBe(true);
      expect(mocks.release).toHaveBeenCalledTimes(2);
    });
  });

  it('reports a real competing execution lease as not submitted', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const held = withSandboxExecutionLease(grant.sandbox.id, () => blocked);
    try {
      await withClient(async (client) => {
        const result = await client.callTool({ name: 'shell_exec', arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain('No command was submitted');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledTimes(1);
      });
    } finally { unblock(); await held; }
  });

  it('does not dispatch when workspace admission fails', async () => {
    mocks.begin.mockReturnValue(null);
    await withClient(async (client) => {
      const result = await client.callTool({ name: 'shell_exec', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('No command was submitted');
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
    });
  });

  it('does not dispatch to a stopped sandbox', async () => {
    grant.sandbox.deployment.status = 'stopped';
    await withClient(async (client) => {
      const result = await client.callTool({ name: 'shell_exec', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('No command was submitted');
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
  });

  it('checks revocation again between HTTP admission and tool dispatch', async () => {
    mocks.grant.mockResolvedValueOnce(grant).mockResolvedValue(null);
    const response = await handleSandboxMcp(new Request(endpoint(), {
      method: 'POST', headers: {
        authorization: 'Bearer boundary-test-token',
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: {} } }),
    }), grant.sandbox.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).toContain('Tool not authorized');
    expect(mocks.grant).toHaveBeenCalledTimes(2);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('keeps authorization metadata gateway-owned and omits private runtime tools', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['sandbox_info']);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[0]._meta).toEqual({ securitySchemes: [{ type: 'oauth2', scopes: ['sandbox:read'] }] });
      expect(JSON.stringify(tools)).not.toContain('must-not-escape');
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
  });
});
