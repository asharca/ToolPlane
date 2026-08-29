// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildKeylessWebSearchToolSet } from '@/lib/chat/keyless-web-search';

describe('keyless web search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls Cherry Studio\'s default Exa MCP search without an API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: ToolPlane\\nURL: https://toolplane.example\\nText: Current result"}]},"jsonrpc":"2.0","id":1}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const output = await buildKeylessWebSearchToolSet().web_search!.execute({ query: 'ToolPlane latest' });

    expect(output).toEqual({
      content: [{ type: 'text', text: 'Title: ToolPlane\nURL: https://toolplane.example\nText: Current result' }],
    });
    const [url, init] = fetchMock.mock.lastCall as [string, RequestInit];
    expect(url).toBe('https://mcp.exa.ai/mcp');
    expect(new Headers(init.headers).has('x-api-key')).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      method: 'tools/call',
      params: expect.objectContaining({
        name: 'web_search_exa',
        arguments: expect.objectContaining({ query: 'ToolPlane latest', numResults: 5 }),
      }),
    }));
  });

  it('rejects oversized provider responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'x'.repeat(128 * 1024 + 1),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));

    await expect(buildKeylessWebSearchToolSet().web_search!.execute({ query: 'ToolPlane' }))
      .rejects.toThrow('response exceeded the size limit');
  });
});
