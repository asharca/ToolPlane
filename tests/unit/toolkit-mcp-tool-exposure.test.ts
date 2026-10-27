// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as McpToolExposure from "@/lib/workspace/mcp-tool-exposure";

const mocks = vi.hoisted(() => ({
  resolveRequestPrincipal: vi.fn(),
  toolkitFindFirst: vi.fn(),
  liveStatus: vi.fn(),
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
  logRequest: vi.fn(),
  loadMcpToolPolicies: vi.fn(),
}));

vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.resolveRequestPrincipal,
}));
vi.mock("@/lib/db", () => ({
  db: { toolkit: { findFirst: mocks.toolkitFindFirst } },
}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: mocks.liveStatus }));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: mocks.listMcpTools,
  mcpRpc: mocks.mcpRpc,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: mocks.logRequest }));
vi.mock("@/lib/workspace/mcp-tool-exposure", async (importOriginal) => {
  const actual = await importOriginal<typeof McpToolExposure>();
  return { ...actual, loadMcpToolPolicies: mocks.loadMcpToolPolicies };
});

import { POST } from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/mcp/route";

function request(method: string, params: Record<string, unknown> = {}) {
  return new Request(
    "http://localhost/api/v1/workspaces/acme/toolkits/default/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
  );
}

const routeParams = {
  params: Promise.resolve({ slug: "acme", toolkitSlug: "default" }),
};

describe("toolkit MCP tool exposure", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestPrincipal.mockResolvedValue({
      user: { id: "user1" },
      token: null,
      credential: "session",
    });
    mocks.toolkitFindFirst.mockResolvedValue({
      name: "Default",
      workspaceId: "ws1",
      servers: [{ deploymentId: "dep1" }],
    });
    mocks.liveStatus.mockReturnValue("running");
    mocks.listMcpTools.mockResolvedValue([{ name: "read" }, { name: "write" }]);
    mocks.mcpRpc.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.logRequest.mockResolvedValue(undefined);
    mocks.loadMcpToolPolicies.mockResolvedValue(
      new Map([["dep1", { mode: "allowlist", allowedTools: ["read"] }]]),
    );
  });

  it("rejects unauthenticated and inaccessible toolkit requests before reading RPC", async () => {
    mocks.resolveRequestPrincipal.mockResolvedValueOnce(null);
    expect((await POST(request("tools/call"), routeParams)).status).toBe(401);
    expect(mocks.toolkitFindFirst).not.toHaveBeenCalled();
    mocks.toolkitFindFirst.mockResolvedValueOnce(null);
    expect((await POST(request("tools/call"), routeParams)).status).toBe(404);
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });

  it("rejects direct calls to hidden tools without invoking the MCP", async () => {
    const response = await POST(
      request("tools/call", {
        name: "dep1__write",
        arguments: {},
      }),
      routeParams,
    );

    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });

  it("does not inspect a deployment missing from the workspace-scoped policy map", async () => {
    mocks.loadMcpToolPolicies.mockResolvedValue(new Map());

    const response = await POST(request("tools/list"), routeParams);

    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [] },
    });
    expect(mocks.liveStatus).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it.each([undefined, { query: "x" }])(
    "dispatches allowed calls with arguments %j and audits their result",
    async (args) => {
      const response = await POST(
        request("tools/call", {
          name: "dep1__read",
          arguments: args,
        }),
        routeParams,
      );
      expect(await response.json()).toMatchObject({
        result: { content: [{ text: "ok" }] },
      });
      expect(mocks.mcpRpc).toHaveBeenCalledWith("dep1", "tools/call", {
        name: "read",
        arguments: args ?? {},
      });
      expect(mocks.logRequest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "success" }),
      );
    },
  );
});
