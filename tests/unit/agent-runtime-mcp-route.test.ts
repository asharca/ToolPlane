// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  runtime: vi.fn(),
  agent: vi.fn(),
  verify: vi.fn(),
  deployments: vi.fn(),
  tools: vi.fn(),
  rpc: vi.fn(),
  status: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: m.log }));
vi.mock("@/lib/observability/context", () => ({ enrichLogContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agentRuntime: { findUnique: m.runtime },
    deployment: { findMany: m.deployments },
  },
}));
vi.mock("@/lib/agents/queries", () => ({ getAgent: m.agent }));
vi.mock("@/lib/agents/resolve", () => ({
  resolveAgentTools: () => ({ deploymentIds: ["mcp", "stale", "unapproved"] }),
}));
vi.mock("@/lib/agents/hermes/token", () => ({
  verifyHermesRuntimeToken: m.verify,
}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: m.status }));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: m.tools,
  mcpRpc: m.rpc,
  McpPayloadTooLargeError: class extends Error {},
}));
import { McpPayloadTooLargeError } from "@/lib/process/mcp-client";
import { POST, GET } from "@/app/api/v1/agent-runtimes/[runtimeId]/mcp/route";
const context = { params: Promise.resolve({ runtimeId: "runtime" }) };
const allocation = {
  revision: {
    deploymentIds: ["mcp", "unapproved"],
    toolPolicy: { mcp: ["read"] },
  },
};
const agent = {
  name: "Public",
  runtime: {
    id: "runtime",
    sandbox: { config: { managedBy: "agent-endpoint-runtime" } },
  },
  publicRuntimeAllocation: allocation,
};
function request(
  method = "tools/list",
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: "Bearer secret", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  m.runtime.mockResolvedValue({
    kind: "hermes",
    workspaceId: "workspace",
    agentId: "agent",
  });
  m.verify.mockReturnValue(true);
  m.agent.mockResolvedValue(agent);
  m.deployments.mockResolvedValue([
    {
      id: "mcp",
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["read", "write"],
      publicInvocable: true,
    },
    {
      id: "unapproved",
      mcpToolExposure: "all",
      mcpAllowedTools: [],
      publicInvocable: false,
    },
  ]);
  m.status.mockReturnValue("running");
  m.tools.mockResolvedValue([
    { name: "read" },
    { name: "write" },
    { name: "hidden" },
  ]);
  m.rpc.mockResolvedValue({
    content: [{ type: "text", text: "file content" }],
  });
});
describe("public runtime MCP boundary", () => {
  it("rejects HTTP GET and invalid runtime credentials", async () => {
    expect(GET().status).toBe(405);
    m.runtime.mockResolvedValueOnce(null).mockResolvedValueOnce({ kind: "pi" });
    for (let i = 0; i < 2; i++)
      expect((await POST(request(), context)).status).toBe(401);
    m.verify.mockReturnValue(false);
    expect((await POST(request(), context)).status).toBe(401);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { runtime: null },
    { runtime: { id: "different" } },
    { ...agent, publicRuntimeAllocation: null },
  ])("hides missing or orphaned runtime allocations: %j", async (value) => {
    m.agent.mockResolvedValue(value);
    expect((await POST(request(), context)).status).toBe(404);
    expect(m.tools).not.toHaveBeenCalled();
  });
  it("rejects oversized announced and streamed requests and malformed JSON", async () => {
    expect(
      (
        await POST(
          request("ping", {}, { "content-length": String(256 * 1024 + 1) }),
          context,
        )
      ).status,
    ).toBe(413);
    expect(
      (await POST(request("ping", { data: "x".repeat(256 * 1024) }), context))
        .status,
    ).toBe(413);
    const bad = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: "{",
    });
    expect((await POST(bad, context)).status).toBe(400);
  });
  it("intersects current exposure, publication snapshot and public deployment approval", async () => {
    const response = await POST(request(), context);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "mcp__read",
            description: "read",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    expect(m.tools).toHaveBeenCalledTimes(1);
    expect(m.tools).toHaveBeenCalledWith("mcp", {
      signal: expect.any(AbortSignal),
      maxResponseBytes: 512 * 1024,
    });
    expect(m.deployments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["mcp", "unapproved"] }, workspaceId: "workspace" },
      }),
    );
  });
  it.each([
    "stale__read",
    "unapproved__read",
    "mcp__hidden",
    "mcp__write",
    "read",
  ])("rejects tools outside all intersected policies: %s", async (name) => {
    const response = await POST(request("tools/call", { name }), context);
    expect(await response.json()).toMatchObject({
      error: { code: -32602, message: `Unknown tool: ${name}` },
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not list or call stopped deployments", async () => {
    m.status.mockReturnValue("stopped");
    expect(await (await POST(request(), context)).json()).toMatchObject({
      result: { tools: [] },
    });
    expect(
      await (
        await POST(request("tools/call", { name: "mcp__read" }), context)
      ).json(),
    ).toMatchObject({
      error: { code: -32000, message: "tool deployment is not running" },
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("caps both individual and combined public tool catalogs", async () => {
    m.tools.mockRejectedValueOnce(new McpPayloadTooLargeError());
    expect((await POST(request(), context)).status).toBe(502);
    m.tools.mockResolvedValueOnce([
      { name: "read", description: "x".repeat(512 * 1024) },
    ]);
    const response = await POST(request(), context);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { message: "public MCP tool catalog is too large" },
    });
  });
  it("calls an allowed tool with byte limits and does not record public payloads", async () => {
    const response = await POST(
      request("tools/call", {
        name: "mcp__read",
        arguments: { path: "secret.txt" },
      }),
      context,
    );
    expect(await response.json()).toMatchObject({
      result: { content: [{ text: "file content" }] },
    });
    expect(m.rpc).toHaveBeenCalledWith(
      "mcp",
      "tools/call",
      { name: "read", arguments: { path: "secret.txt" } },
      30000,
      {
        signal: expect.any(AbortSignal),
        maxRequestBytes: 256 * 1024,
        maxResponseBytes: 512 * 1024,
      },
    );
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: null,
        response: undefined,
        payloadPolicy: "forbidden",
      }),
    );
  });
  it.each([
    null,
    new Error("private backend details"),
    new McpPayloadTooLargeError(),
  ])("returns safe errors for failed tool invocations: %j", async (failure) => {
    if (failure instanceof Error) m.rpc.mockRejectedValue(failure);
    else m.rpc.mockResolvedValue(failure);
    const response = await POST(
      request("tools/call", { name: "mcp__read" }),
      context,
    );
    expect(await response.json()).toMatchObject({
      error: {
        message:
          failure instanceof McpPayloadTooLargeError
            ? "public MCP tool payload is too large"
            : "tool deployment is unreachable",
      },
    });
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error" }),
    );
  });
  it("handles protocol initialization, ping and notifications without exposing tools", async () => {
    expect(
      await (await POST(request("initialize"), context)).json(),
    ).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "ToolPlane: Public" },
      },
    });
    expect(await (await POST(request("ping"), context)).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    for (const method of ["initialized", "notifications/initialized"])
      expect((await POST(request(method), context)).status).toBe(202);
    expect(
      await (await POST(request("unsupported"), context)).json(),
    ).toMatchObject({ error: { code: -32601 } });
  });
});
