// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  principal: vi.fn(),
  toolkit: vi.fn(),
  deployments: vi.fn(),
  live: vi.fn(),
  tools: vi.fn(),
  rpc: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: m.principal,
}));
vi.mock("@/lib/db", () => ({
  db: {
    toolkit: { findFirst: m.toolkit },
    deployment: { findMany: m.deployments },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: m.live }));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: m.tools,
  mcpRpc: m.rpc,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: m.log }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import {
  GET,
  POST,
} from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route";

const ctx = { params: Promise.resolve({ slug: "team", toolkitSlug: "kit" }) };
function request(body: unknown) {
  return new Request("https://test/api", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
async function call(body: unknown) {
  return POST(request(body), ctx);
}

describe("toolkit MCP transport boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.principal.mockResolvedValue({ user: { id: "user" }, token: null });
    m.toolkit.mockResolvedValue({
      name: "Kit",
      workspaceId: "ws",
      servers: [{ deploymentId: "dep" }],
    });
    m.deployments.mockResolvedValue([
      {
        id: "dep",
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["read"],
        publicInvocable: false,
      },
    ]);
    m.live.mockReturnValue("running");
    m.tools.mockResolvedValue([{ name: "read" }, { name: "secret" }]);
    m.rpc.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  });
  it("rejects unauthenticated and inaccessible toolkit requests before reading RPC", async () => {
    m.principal.mockResolvedValueOnce(null);
    expect((await call({ method: "ping" })).status).toBe(401);
    expect(m.toolkit).not.toHaveBeenCalled();
    m.toolkit.mockResolvedValueOnce(null);
    expect((await call({ method: "ping" })).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([null, { toolkitId: null }, { toolkitId: "scope" }])(
    "intersects membership and credential scope %j",
    async (token) => {
      m.principal.mockResolvedValue({ user: { id: "user" }, token });
      const response = await call({ id: 1, method: "ping" });
      expect(response.status).toBe(200);
      expect(m.toolkit).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ...(token?.toolkitId ? { id: "scope" } : {}),
            slug: "kit",
            enabled: true,
            workspace: {
              slug: "team",
              status: "active",
              OR: [
                { ownerId: "user" },
                { members: { some: { userId: "user" } } },
              ],
            },
          },
        }),
      );
    },
  );
  it("reports malformed JSON with a null RPC identifier", async () => {
    const response = await POST(
      new Request("https://test/api", { method: "POST", body: "{" }),
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: null,
      error: { code: -32700 },
    });
  });
  it("negotiates the protocol and advertises the toolkit name", async () => {
    expect(
      await (await call({ id: "init", method: "initialize" })).json(),
    ).toEqual({
      jsonrpc: "2.0",
      id: "init",
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "Kit", version: "1.0.0" },
      },
    });
    expect(m.deployments).not.toHaveBeenCalled();
  });
  it.each(["notifications/initialized", "initialized"])(
    "acknowledges %s without an audit record",
    async (method) => {
      expect((await call({ method })).status).toBe(202);
      expect(m.log).not.toHaveBeenCalled();
    },
  );
  it("accepts an unknown-method notification", async () => {
    expect((await call({ method: "unknown" })).status).toBe(202);
  });
  it.each([{ id: 3 }, { id: 0, method: "unknown" }])(
    "reports unsupported methods %j",
    async (msg) => {
      expect(await (await call(msg)).json()).toMatchObject({
        id: msg.id,
        error: { code: -32601 },
      });
      expect(m.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error" }),
      );
    },
  );
  it("lists only live deployments with workspace-owned policies and allowed tools", async () => {
    m.toolkit.mockResolvedValue({
      name: "Kit",
      workspaceId: "ws",
      servers: ["dep", "stopped", "foreign"].map((deploymentId) => ({
        deploymentId,
      })),
    });
    m.deployments.mockResolvedValue([
      {
        id: "dep",
        mcpToolExposure: "all",
        mcpAllowedTools: [],
        publicInvocable: true,
      },
      { id: "stopped", mcpToolExposure: "all", mcpAllowedTools: [] },
    ]);
    m.live.mockImplementation((id: string) =>
      id === "stopped" ? "stopped" : "running",
    );
    m.tools.mockResolvedValue([
      { name: "read" },
      {
        name: "write",
        description: "Save",
        inputSchema: { type: "object", required: ["value"] },
      },
    ]);
    expect(
      await (await call({ id: 1, method: "tools/list" })).json(),
    ).toMatchObject({
      result: {
        tools: [
          {
            name: "dep__read",
            description: "read",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "dep__write",
            description: "Save",
            inputSchema: { type: "object", required: ["value"] },
          },
        ],
      },
    });
    expect(m.tools).toHaveBeenCalledTimes(1);
    expect(m.deployments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["dep", "stopped", "foreign"] }, workspaceId: "ws" },
      }),
    );
  });
  it("filters hidden tools and handles an empty toolkit", async () => {
    expect(
      await (await call({ id: 1, method: "tools/list" })).json(),
    ).toMatchObject({ result: { tools: [{ name: "dep__read" }] } });
    m.toolkit.mockResolvedValue({
      name: "Empty",
      workspaceId: "ws",
      servers: [],
    });
    expect(
      await (await call({ id: 2, method: "tools/list" })).json(),
    ).toMatchObject({ result: { tools: [] } });
  });
  it.each([undefined, "read", "other__read", "dep__secret"])(
    "does not dispatch unauthorized tool name %s",
    async (name) => {
      expect(
        await (
          await call({ id: 2, method: "tools/call", params: { name } })
        ).json(),
      ).toMatchObject({ error: { code: -32602 } });
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects a tool whose deployment has no workspace policy", async () => {
    m.deployments.mockResolvedValue([]);
    expect(
      await (
        await call({
          id: 2,
          method: "tools/call",
          params: { name: "dep__read" },
        })
      ).json(),
    ).toMatchObject({ error: { code: -32602 } });
  });
  it("distinguishes stopped and unreachable deployments", async () => {
    m.live.mockReturnValueOnce("stopped");
    expect(
      await (
        await call({
          id: 2,
          method: "tools/call",
          params: { name: "dep__read" },
        })
      ).json(),
    ).toMatchObject({ error: { message: "tool deployment is not running" } });
    m.rpc.mockResolvedValueOnce(null);
    expect(
      await (
        await call({
          id: 2,
          method: "tools/call",
          params: { name: "dep__read" },
        })
      ).json(),
    ).toMatchObject({ error: { message: "tool deployment is unreachable" } });
  });
  it.each([undefined, { query: "x" }])(
    "dispatches allowed calls with arguments %j and audits their result",
    async (args) => {
      const response = await call({
        id: 2,
        method: "tools/call",
        params: { name: "dep__read", arguments: args },
      });
      expect(await response.json()).toMatchObject({
        result: { content: [{ text: "ok" }] },
      });
      expect(m.rpc).toHaveBeenCalledWith("dep", "tools/call", {
        name: "read",
        arguments: args ?? {},
      });
      expect(m.log).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: "dep",
          path: "/workspaces/team/toolkits/kit/mcp#tools/call:read",
          outcome: "success",
          requestBody: JSON.stringify({ name: "read", arguments: args ?? {} }),
        }),
      );
    },
  );
  it("preserves tool failures and marks the audit outcome", async () => {
    m.rpc.mockResolvedValue({ isError: true, content: [] });
    expect(
      await (
        await call({
          id: 2,
          method: "tools/call",
          params: { name: "dep__read" },
        })
      ).json(),
    ).toMatchObject({ result: { isError: true } });
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error" }),
    );
  });
  it("does not advertise an SSE stream", async () => {
    expect(GET().status).toBe(405);
  });
});
