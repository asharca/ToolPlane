import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mcpRpc: vi.fn(),
  startProcess: vi.fn(),
  killProcess: vi.fn(),
  resolveSpawnSpec: vi.fn(() => ({ kind: 'bridge', name: 'test', command: 'node', args: [], env: {} })),
}));

vi.mock('@/lib/process/spawn-spec', () => ({
  resolveSpawnSpec: mocks.resolveSpawnSpec,
}));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: mocks.startProcess,
  killProcess: mocks.killProcess,
  livePort: () => 4321,
  liveStatus: () => 'running',
}));
vi.mock('@/lib/process/mcp-client', () => ({
  McpPayloadTooLargeError: class McpPayloadTooLargeError extends Error {},
  mcpRpc: mocks.mcpRpc,
}));

import { validateServerRecipe } from '@/lib/admin/recipe-validate';

const recipe = { source: 'npm' as const, ref: '@acme/mcp', env: [] };
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });

describe('validateServerRecipe tool discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startProcess.mockResolvedValue(undefined);
    mocks.killProcess.mockResolvedValue(undefined);
  });

  it('accepts a catalog only after an explicit terminal page', async () => {
    mocks.mcpRpc
      .mockResolvedValueOnce({ tools: [tool('search')], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [tool('write')] });

    await expect(validateServerRecipe(recipe)).resolves.toMatchObject({
      ok: true,
      toolCount: 2,
      tools: ['search', 'write'],
    });
    expect(mocks.killProcess).toHaveBeenCalledOnce();
  });

  it('rejects a catalog that still has a cursor at the page limit', async () => {
    let page = 0;
    mocks.mcpRpc.mockImplementation(async () => {
      page += 1;
      return { tools: [tool(`tool-${page}`)], nextCursor: `page-${page + 1}` };
    });

    await expect(validateServerRecipe(recipe)).resolves.toMatchObject({ ok: false });
    expect(page).toBe(10);
    expect(mocks.killProcess).toHaveBeenCalledOnce();
  });

  it('rejects a response without a tools array', async () => {
    mocks.mcpRpc.mockResolvedValue({});

    await expect(validateServerRecipe(recipe)).resolves.toMatchObject({ ok: false });
    expect(mocks.killProcess).toHaveBeenCalledOnce();
  });

  it('rejects credential redaction that changes a tool name', async () => {
    mocks.mcpRpc.mockResolvedValue({ tools: [tool('credential-name')] });

    await expect(validateServerRecipe(
      { ...recipe, env: ['API_KEY'] },
      { API_KEY: 'credential-name' },
    )).resolves.toMatchObject({ ok: false });
    expect(mocks.killProcess).toHaveBeenCalledOnce();
  });

  it('validates remote connectors through the shared spawn resolver', async () => {
    mocks.mcpRpc.mockResolvedValue({ tools: [tool('remote-search')] });

    await expect(validateServerRecipe({
      source: 'remote',
      ref: 'https://mcp.example.com/mcp',
      env: ['MCP_BEARER_TOKEN'],
      authType: 'bearer',
      bearerEnv: 'MCP_BEARER_TOKEN',
      transport: 'streamable-http',
    }, { MCP_BEARER_TOKEN: 'test-token' })).resolves.toMatchObject({ ok: true, toolCount: 1 });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(expect.objectContaining({
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      installCfg: expect.objectContaining({ env: { MCP_BEARER_TOKEN: 'test-token' } }),
    }), true);
  });
});
