// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  livePort: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));

import { getMcpPrompt, listMcpPrompts } from '@/lib/process/mcp-client';

function rpcResult(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(call: number) {
  const init = mocks.fetch.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as {
    method: string;
    params?: Record<string, unknown>;
  };
}

describe('MCP prompt client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.livePort.mockReturnValue(4312);
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('paginates, normalizes, and de-duplicates prompt listings', async () => {
    mocks.fetch
      .mockResolvedValueOnce(rpcResult({
        prompts: [
          {
            name: ' summarize ',
            title: ' Summary ',
            arguments: [{ name: ' text ', description: ' Source ', required: true }],
          },
          {
            name: 'invalid',
            arguments: [{ name: 'same' }, { name: 'same' }],
          },
        ],
        nextCursor: 'next-page',
      }))
      .mockResolvedValueOnce(rpcResult({
        prompts: [
          { name: 'summarize', arguments: [] },
          { name: 'rewrite', description: ' Rewrite it ', arguments: [] },
        ],
      }));

    await expect(listMcpPrompts('dep-1')).resolves.toEqual([
      {
        name: 'summarize',
        title: 'Summary',
        arguments: [{ name: 'text', description: 'Source', required: true }],
      },
      { name: 'rewrite', description: 'Rewrite it', arguments: [] },
    ]);
    expect(requestBody(0)).toMatchObject({ method: 'prompts/list' });
    expect(requestBody(0).params).toBeUndefined();
    expect(requestBody(1)).toMatchObject({
      method: 'prompts/list',
      params: { cursor: 'next-page' },
    });
  });

  it('passes prompt arguments and accepts a valid prompt response', async () => {
    mocks.fetch.mockResolvedValue(rpcResult({
      description: ' A useful prompt ',
      messages: [{ role: 'user', content: { type: 'text', text: 'Review ToolPlane' } }],
    }));

    await expect(getMcpPrompt('dep-1', 'review', { repo: 'ToolPlane' })).resolves.toEqual({
      description: 'A useful prompt',
      messages: [{ role: 'user', content: { type: 'text', text: 'Review ToolPlane' } }],
    });
    expect(requestBody(0)).toMatchObject({
      method: 'prompts/get',
      params: { name: 'review', arguments: { repo: 'ToolPlane' } },
    });
  });

  it('rejects malformed prompt messages', async () => {
    mocks.fetch.mockResolvedValue(rpcResult({
      messages: [{ role: 'tool', content: { type: 'text', text: 'not allowed' } }],
    }));

    await expect(getMcpPrompt('dep-1', 'review')).resolves.toBeNull();
  });
});
