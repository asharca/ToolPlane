// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestPrincipal: vi.fn(),
  deploymentFindFirst: vi.fn(),
  livePort: vi.fn(),
  liveRedactionValues: vi.fn(),
  logRequest: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.resolveRequestPrincipal,
}));
vi.mock("@/lib/db", () => ({
  db: { deployment: { findFirst: mocks.deploymentFindFirst } },
}));
vi.mock("@/lib/process/supervisor", () => ({
  livePort: mocks.livePort,
  liveRedactionValues: mocks.liveRedactionValues,
}));
vi.mock("@/lib/observability/events", () => ({
  recordEvent: mocks.logRequest,
}));

import { POST } from "@/app/api/v1/mcp/[deploymentId]/rpc/route";
import { proxyMcpRpcRequest } from "@/lib/process/mcp-gateway";

function request(method: string, params?: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/mcp/dep1/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function batchRequest(method: string) {
  return new Request("http://localhost/api/v1/mcp/dep1/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method, params: { name: "write" } },
    ]),
  });
}

describe("direct MCP gateway tool exposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestPrincipal.mockResolvedValue({
      user: { id: "user1" },
      credential: "session",
      token: null,
    });
    mocks.deploymentFindFirst.mockResolvedValue({
      id: "dep1",
      workspaceId: "ws1",
      status: "running",
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["read"],
    });
    mocks.livePort.mockReturnValue(4321);
    mocks.liveRedactionValues.mockReturnValue([]);
    mocks.logRequest.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("filters tools/list to the allowlist", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "read" }, { name: "write" }] },
        }),
      ),
    );

    const response = await POST(request("tools/list"), {
      params: Promise.resolve({ deploymentId: "dep1" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [{ name: "read" }] },
    });
  });

  it("rejects a hidden tools/call without contacting the MCP process", async () => {
    const response = await POST(
      request("tools/call", {
        name: "write",
        arguments: {},
      }),
      { params: Promise.resolve({ deploymentId: "dep1" }) },
    );

    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32602, message: "Unknown tool: write" },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("denies non-tool capabilities on package grants before contacting the service", async () => {
    const response = await proxyMcpRpcRequest(
      request("resources/read", { uri: "private://credentials" }),
      {
        id: "dep1",
        workspaceId: "ws1",
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["read"],
        toolsOnly: true,
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32601 },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["tools/list", "tools/call"])(
    "rejects batch %s requests before they can bypass policy",
    async (method) => {
      const response = await POST(batchRequest(method), {
        params: Promise.resolve({ deploymentId: "dep1" }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32600 },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("removes non-tool server capabilities from a restricted initialization", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          capabilities: {
            tools: {},
            resources: { subscribe: true },
            prompts: {},
          },
        },
      }),
    );
    const response = await proxyMcpRpcRequest(request("initialize"), {
      id: "dep1",
      workspaceId: "ws1",
      mcpToolExposure: "all",
      mcpAllowedTools: [],
      toolsOnly: true,
    });
    expect((await response.json()).result.capabilities).toEqual({ tools: {} });
  });
  it("rejects retired toolkit credentials on the account endpoint", async () => {
    mocks.resolveRequestPrincipal.mockResolvedValue({
      user: { id: "user1" },
      credential: "toolkit-token",
      token: { id: "t1" },
    });
    const response = await POST(request("tools/list"), {
      params: Promise.resolve({ deploymentId: "dep1" }),
    });
    expect(response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("filters fragmented streamed tool lists inside a negotiated legacy batch", async () => {
    const req = batchRequest("tools/list");
    req.headers.set("mcp-session-id", "s");
    req.headers.set("mcp-protocol-version", "2025-03-26");
    const wire =
      "data: " +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "read" }, { name: "unknown" }] },
      }) +
      "\r\n\r\n";
    const encoder = new TextEncoder();
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            for (const part of [
              wire.slice(0, 35),
              wire.slice(35, -1),
              wire.slice(-1),
            ])
              c.enqueue(encoder.encode(part));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const res = await POST(req, {
      params: Promise.resolve({ deploymentId: "dep1" }),
    });
    const stream = await res.text();
    expect(stream).toContain('"read"');
    expect(stream).not.toContain("unknown");
  });

  it("streams tool results that echo deployment configuration values unchanged", async () => {
    const configLine = '"host": "192.0.2.10",';
    mocks.liveRedactionValues.mockReturnValue([configLine]);
    const text = `{\n  "devices": [\n    {\n      ${configLine}\n      "enabled": true\n    }\n  ]\n}`;
    const reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }], isError: false },
    };
    mocks.fetch.mockResolvedValue(
      new Response(`data: ${JSON.stringify(reply)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const res = await POST(request("tools/call", { name: "read" }), {
      params: Promise.resolve({ deploymentId: "dep1" }),
    });
    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(JSON.parse(stream.slice(stream.indexOf("data: ") + 6))).toEqual(
      reply,
    );
  });

  it("rejects a batch at the modern protocol version even with a session id", async () => {
    const req = batchRequest("tools/list");
    req.headers.set("mcp-session-id", "s");
    req.headers.set("mcp-protocol-version", "2025-11-25");
    const res = await POST(req, {
      params: Promise.resolve({ deploymentId: "dep1" }),
    });
    expect(res.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
