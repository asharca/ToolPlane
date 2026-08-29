import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  liveMcpRuntimeSnapshot: vi.fn(),
}));

vi.mock('@/lib/process/supervisor', () => ({
  livePort: () => 4321,
  liveMcpRuntimeSnapshot: mocks.liveMcpRuntimeSnapshot,
}));
vi.mock('@/lib/process/mcp-tool-catalog-store', () => ({
  persistDeploymentMcpToolCatalog: mocks.persist,
}));

import { listMcpTools } from '@/lib/process/mcp-client';

function rpcResult(result: Record<string, unknown>) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

function tool(name: string) {
  return { name, inputSchema: { type: 'object' } };
}

describe('listMcpTools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.liveMcpRuntimeSnapshot.mockReturnValue({
      port: 4321,
      generation: 'generation-1',
      redactionValues: [],
    });
    mocks.persist.mockImplementation(async (_id: string, tools: unknown) => tools);
  });

  it('merges paginated tools and persists one complete snapshot', async () => {
    mocks.liveMcpRuntimeSnapshot
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: ['first-page-secret'] })
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: ['first-page-secret'] })
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: ['second-page-secret'] })
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: ['second-page-secret'] });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rpcResult({ tools: [tool('search')], nextCursor: 'opaque cursor' }))
      .mockResolvedValueOnce(rpcResult({ tools: [tool('write')] }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([
      tool('search'),
      tool('write'),
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      params: { cursor: 'opaque cursor' },
    });
    expect(mocks.persist).toHaveBeenCalledWith('dep-1', [
      tool('search'),
      tool('write'),
    ], ['first-page-secret', 'second-page-secret']);
  });

  it('fails closed when the live owner cannot provide its redaction values', async () => {
    mocks.liveMcpRuntimeSnapshot.mockReturnValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('fails closed when the deployment restarts while a page is in flight', async () => {
    mocks.liveMcpRuntimeSnapshot
      .mockReturnValueOnce({ port: 4321, generation: 'old-generation', redactionValues: ['old-secret'] })
      .mockReturnValueOnce({ port: 9876, generation: 'new-generation', redactionValues: ['new-secret'] });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResult({
      tools: [{
        name: 'echo_secret',
        description: 'old-secret',
        inputSchema: { type: 'object' },
      }],
    }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4321/', expect.any(Object));
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('fails closed when the deployment exits after returning a page', async () => {
    mocks.liveMcpRuntimeSnapshot
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: ['exit-secret'] })
      .mockReturnValueOnce(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResult({
      tools: [{ name: 'echo_secret', description: 'exit-secret', inputSchema: { type: 'object' } }],
    }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('does not continue pagination if the bound port changes between pages', async () => {
    mocks.liveMcpRuntimeSnapshot
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: [] })
      .mockReturnValueOnce({ port: 4321, generation: 'generation-1', redactionValues: [] })
      .mockReturnValueOnce({ port: 9876, generation: 'generation-1', redactionValues: [] });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResult({
      tools: [tool('first')],
      nextCursor: 'page-2',
    }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('does not persist a partial snapshot when a later page fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rpcResult({ tools: [tool('search')], nextCursor: 'page-2' }))
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('rejects an oversized catalog without persisting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'content-length': '4000001' },
    }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('rejects a response without a tools array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResult({ nextCursor: null }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('does not persist when pagination exceeds the page limit', async () => {
    let page = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      page += 1;
      return rpcResult({ tools: [tool(`tool-${page}`)], nextCursor: `page-${page + 1}` });
    });

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(page).toBe(10);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('rejects cyclic and explicitly null cursors', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rpcResult({ tools: [tool('one')], nextCursor: 'A' }))
      .mockResolvedValueOnce(rpcResult({ tools: [tool('two')], nextCursor: 'B' }))
      .mockResolvedValueOnce(rpcResult({ tools: [tool('three')], nextCursor: 'A' }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();

    vi.mocked(globalThis.fetch).mockReset().mockResolvedValue(rpcResult({ tools: [], nextCursor: null }));
    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('enforces one raw response-byte budget across all pages', async () => {
    const padding = 'x'.repeat(2_100_000);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rpcResult({ tools: [tool('one')], padding, nextCursor: 'page-2' }))
      .mockResolvedValueOnce(rpcResult({ tools: [tool('two')], padding }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('rejects a tool whose required schema would be truncated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResult({
      tools: [{
        name: 'oversized',
        inputSchema: { type: 'object', description: 'x'.repeat(256_001) },
      }],
    }));

    await expect(listMcpTools('dep-1')).resolves.toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
