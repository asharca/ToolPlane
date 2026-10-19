import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKeylessWebSearchToolSet } from "@/lib/chat/keyless-web-search";

describe("keyless web search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, null, 5, "", " \n "])(
    "rejects empty or non-string queries %s before fetching",
    async (query) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        buildKeylessWebSearchToolSet().web_search.execute({ query }),
      ).rejects.toThrow("Search query is required.");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("bounds queries and propagates a request abort to the provider", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ result: { content: [{ text: "answer" }] } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const tool = buildKeylessWebSearchToolSet(controller.signal).web_search;
    await expect(tool.execute({ query: "x".repeat(501) })).rejects.toThrow(
      "at most 500",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await tool.execute({ query: "  question  " });
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).params.arguments.query,
    ).toBe("question");
    controller.abort();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("skips malformed SSE messages and joins only readable text fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'event: message\ndata: bad-json\ndata: [DONE]\ndata: \ndata: {"result":{"content":[{"text":5},{"text":" "},{"text":" One "},{"text":" Two "}]}}\n',
          ),
        ),
    );
    await expect(
      buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
    ).resolves.toEqual({ content: [{ type: "text", text: "One\n\nTwo" }] });
  });

  it.each(["not-json", "{}", '{"result":{"content":[]}}', '{"result":{}}'])(
    "rejects unreadable provider payload %s",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(
        buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
      ).rejects.toThrow("no readable search results");
    },
  );

  it("surfaces JSON-RPC provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: "Rate limit exceeded" } }),
        ),
    );
    await expect(
      buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
    ).rejects.toThrow("Rate limit exceeded");
  });

  it("handles null response bodies and bounds HTTP failure detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          new Response("too\n much\t" + "x".repeat(1000), { status: 503 }),
        ),
    );
    await expect(
      buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
    ).rejects.toThrow("no readable search results");
    await expect(
      buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
    ).rejects.toThrow(
      `Exa MCP search failed (503): ${("too much " + "x".repeat(1000)).slice(0, 500)}`,
    );
  });

  it("truncates readable provider results at the public output limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ result: { content: [{ text: "x".repeat(24001) }] } }),
        ),
    );
    await expect(
      buildKeylessWebSearchToolSet().web_search.execute({ query: "query" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "x".repeat(24000) + "\n\n[Search results truncated]",
        },
      ],
    });
  });

  it("calls Cherry Studio's default Exa MCP search without an API key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: ToolPlane\\nURL: https://toolplane.example\\nText: Current result"}]},"jsonrpc":"2.0","id":1}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const output = await assertDefined(
      buildKeylessWebSearchToolSet().web_search,
    ).execute({
      query: "ToolPlane latest",
    });

    expect(output).toEqual({
      content: [
        {
          type: "text",
          text: "Title: ToolPlane\nURL: https://toolplane.example\nText: Current result",
        },
      ],
    });
    const [url, init] = fetchMock.mock.lastCall as [string, RequestInit];
    expect(url).toBe("https://mcp.exa.ai/mcp");
    expect(new Headers(init.headers).has("x-api-key")).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        method: "tools/call",
        params: expect.objectContaining({
          name: "web_search_exa",
          arguments: expect.objectContaining({
            query: "ToolPlane latest",
            numResults: 5,
          }),
        }),
      }),
    );
  });

  it("rejects oversized provider responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x".repeat(128 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    await expect(
      assertDefined(buildKeylessWebSearchToolSet().web_search).execute({
        query: "ToolPlane",
      }),
    ).rejects.toThrow("response exceeded the size limit");
  });
});
