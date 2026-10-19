// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ControlMcp from "@/lib/agents/control-mcp";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  execute: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAgentControlRequestUser: m.user,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/agents/control-mcp", async (original) => ({
  ...(await original<typeof ControlMcp>()),
  executeAgentControlTool: m.execute,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: m.log }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { AgentControlError } from "@/lib/agents/control-service";
import { AGENT_CONTROL_MCP_TOOLS } from "@/lib/agents/control-mcp";
import { GET, POST } from "@/app/api/v1/workspaces/[slug]/agents/mcp/route";
const ctx = { params: Promise.resolve({ slug: "team" }) };
function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://test/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}
describe("workspace agent control MCP input protocol", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://test");
    m.user.mockResolvedValue({ id: "user" });
    m.workspace.mockResolvedValue({ id: "ws", slug: "team", name: "Team" });
    m.execute.mockResolvedValue({ agents: [] });
  });
  it("rejects foreign origin and oversized declared body before auth", async () => {
    expect(
      (await POST(rpc({}, { origin: "https://evil.test" }), ctx)).status,
    ).toBe(403);
    expect(
      (await POST(rpc({}, { "content-length": "262145" }), ctx)).status,
    ).toBe(413);
    expect(m.user).not.toHaveBeenCalled();
  });
  it("rejects oversized UTF8 bodies and malformed JSON", async () => {
    expect((await POST(rpc({ value: "界".repeat(100000) }), ctx)).status).toBe(
      413,
    );
    expect(
      (
        await POST(
          new Request("https://test/api", { method: "POST", body: "{" }),
          ctx,
        )
      ).status,
    ).toBe(400);
  });
  it.each([
    null,
    [],
    3,
    {},
    { jsonrpc: "1.0", method: "ping" },
    { jsonrpc: "2.0", method: 1 },
    { jsonrpc: "2.0", method: "" },
  ])("rejects invalid envelope %j", async (body) => {
    expect(await (await POST(rpc(body), ctx)).json()).toMatchObject({
      error: { code: -32600 },
    });
  });
  it.each([null, {}, [], true])("rejects invalid request id %j", async (id) => {
    expect(
      (await POST(rpc({ jsonrpc: "2.0", method: "ping", id }), ctx)).status,
    ).toBe(400);
  });
  it.each([null, [], "text", 1])(
    "rejects nonobject params %j",
    async (params) => {
      expect(
        await (
          await POST(
            rpc({ jsonrpc: "2.0", method: "ping", id: 1, params }),
            ctx,
          )
        ).json(),
      ).toMatchObject({ id: 1, error: { code: -32602 } });
    },
  );
  it("rejects unsupported protocol version with and without request id", async () => {
    for (const id of [undefined, 1]) {
      expect(
        (
          await POST(
            rpc(
              { jsonrpc: "2.0", method: "ping", id },
              { "mcp-protocol-version": "future" },
            ),
            ctx,
          )
        ).status,
      ).toBe(400);
    }
  });
  it.each([
    undefined,
    {},
    { protocolVersion: "" },
    { protocolVersion: "2025-06-18", capabilities: [] },
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} },
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "client" },
    },
  ])("rejects incomplete initialization %j", async (params) => {
    expect(
      await (
        await POST(
          rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params }),
          ctx,
        )
      ).json(),
    ).toMatchObject({ error: { code: -32602 } });
  });
  it.each(["2025-06-18", "2025-03-26", "future"])(
    "negotiates requested protocol %s",
    async (protocolVersion) => {
      const response = await POST(
        rpc({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "client", version: "1" },
          },
        }),
        ctx,
      );
      expect(await response.json()).toMatchObject({
        result: {
          protocolVersion:
            protocolVersion === "future" ? "2025-06-18" : protocolVersion,
          serverInfo: { name: "ToolPlane Agent Control: Team" },
        },
      });
    },
  );
  it.each(["initialized", "notifications/initialized", "tools/call"])(
    "never executes notification %s",
    async (method) => {
      expect(
        (
          await POST(
            rpc({ jsonrpc: "2.0", method, params: { name: "list_agents" } }),
            ctx,
          )
        ).status,
      ).toBe(202);
      expect(m.execute).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, {}, { name: 2 }, { name: "unknown" }])(
    "rejects unknown tools %j",
    async (params) => {
      expect(
        await (
          await POST(
            rpc({ jsonrpc: "2.0", id: 0, method: "tools/call", params }),
            ctx,
          )
        ).json(),
      ).toMatchObject({ error: { code: -32602 } });
      expect(m.execute).not.toHaveBeenCalled();
    },
  );
  it("publishes actual control tools and executes in authorized workspace context", async () => {
    expect(
      await (
        await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ctx)
      ).json(),
    ).toMatchObject({ result: { tools: AGENT_CONTROL_MCP_TOOLS } });
    const response = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_agents", arguments: { limit: 5 } },
      }),
      ctx,
    );
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { result: { agents: [] } } },
    });
    expect(m.execute).toHaveBeenCalledWith(
      { workspaceId: "ws", workspaceSlug: "team", actorId: "user" },
      "list_agents",
      { limit: 5 },
    );
  });
  it.each(["not_found", "unavailable", "invalid_arguments"] as const)(
    "returns typed tool failure %s",
    async (code) => {
      m.execute.mockRejectedValue(new AgentControlError(code, "Denied"));
      expect(
        await (
          await POST(
            rpc({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "list_agents" },
            }),
            ctx,
          )
        ).json(),
      ).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code, message: "Denied" } },
        },
      });
      expect(m.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error", error: expect.any(Error) }),
      );
    },
  );
  it("sanitizes unexpected tool errors", async () => {
    m.execute.mockRejectedValue(new Error("secret"));
    expect(
      await (
        await POST(
          rpc({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_agents" },
          }),
          ctx,
        )
      ).json(),
    ).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: {
            code: "internal_error",
            message: "The Agent Control operation failed.",
          },
        },
      },
    });
  });
  it("handles ping and unknown request methods", async () => {
    expect(
      await (
        await POST(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }), ctx)
      ).json(),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(
      await (
        await POST(rpc({ jsonrpc: "2.0", id: 1, method: "unknown" }), ctx)
      ).json(),
    ).toMatchObject({ error: { code: -32601 } });
  });
  it("gates missing account and workspace before parsing", async () => {
    m.user.mockResolvedValueOnce(null);
    expect((await POST(rpc({}), ctx)).status).toBe(401);
    m.workspace.mockResolvedValueOnce(null);
    expect((await POST(rpc({}), ctx)).status).toBe(404);
  });
  it("rejects browser cross-origin GET and otherwise explains the POST transport", async () => {
    expect(
      (
        await GET(
          new Request("https://test/api", {
            headers: { origin: "https://evil.test" },
          }),
        )
      ).status,
    ).toBe(403);
    expect((await GET(new Request("https://test/api"))).status).toBe(405);
    expect(
      (
        await GET(
          new Request("https://test/api", {
            headers: { origin: "https://test" },
          }),
        )
      ).status,
    ).toBe(405);
  });
});
