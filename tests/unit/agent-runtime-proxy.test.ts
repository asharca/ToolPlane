// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  agent: vi.fn(),
  conversation: vi.fn(),
  context: vi.fn(),
  provider: vi.fn(),
  revision: vi.fn(),
  credentials: vi.fn(),
  localToken: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  fetch: vi.fn(),
  logRequest: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    agent: { findFirst: mocks.agent },
    conversation: { findFirst: mocks.conversation },
    a2AContext: { findFirst: mocks.context },
    modelProvider: { findFirst: mocks.provider },
  },
}));
vi.mock("@/lib/agents/revisions", () => ({
  requireAgentRevision: mocks.revision,
}));
vi.mock("@/lib/agents/environment-credentials", () => ({
  assertAgentEnvironmentCredentialReferences: mocks.credentials,
}));
vi.mock("@/lib/a2a/local-runtime", () => ({
  assertLocalRuntimeToken: mocks.localToken,
}));
vi.mock("@/lib/process/session-mcp", () => ({
  listSessionMcpTools: mocks.listTools,
  callSessionMcpTool: mocks.callTool,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: mocks.logRequest }));
import { createAgentRuntimeToken } from "@/lib/agents/runtime-access";
import { POST as proxyModel } from "@/app/api/v1/agent-runtime/model/[providerId]/[[...path]]/route";
import { POST as proxyMcp } from "@/app/api/v1/agent-runtime/mcp/[deploymentId]/rpc/route";

const pin = {
  id: "revision-1",
  config: {
    providerId: "provider-1",
    mcpGrants: [{ deploymentId: "deployment-1", allowedToolNames: ["read"] }],
    environment: { credentialReferences: [] },
  },
};
const identity = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  agentRevisionId: "revision-1",
  sandboxId: "sandbox-1",
  conversationId: "conversation-1",
  providerId: "provider-1",
  deploymentIds: ["deployment-1"],
};

describe("pinned Agent runtime proxy authorization", () => {
  const originalSecret = process.env.AUTH_SECRET;
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.AUTH_SECRET = "runtime-proxy-test-secret";
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        agent: { findFirst: mocks.agent },
        conversation: { findFirst: mocks.conversation },
        a2AContext: { findFirst: mocks.context },
      }),
    );
    mocks.revision.mockResolvedValue(pin);
    mocks.agent.mockResolvedValue({
      servers: [{ deploymentId: "deployment-1", allowedToolNames: ["read"] }],
    });
    mocks.conversation.mockResolvedValue({ id: "conversation-1" });
    mocks.provider.mockResolvedValue({
      name: "OpenAI",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "real-provider-key",
    });
    mocks.fetch.mockResolvedValue(
      new Response("data: chunk\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "provider=x",
        },
      }),
    );
    mocks.listTools.mockResolvedValue([
      { name: "read", inputSchema: { type: "object" } },
    ]);
    mocks.callTool.mockResolvedValue({
      content: [{ type: "text", text: "read result" }],
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
    vi.unstubAllGlobals();
  });
  async function request(path: string, body: unknown = {}) {
    const token = await createAgentRuntimeToken({
      ...identity,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    return new Request(`http://toolplane.test/api/v1/agent-runtime/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        cookie: "runtime=session",
        "x-api-key": "untrusted-key",
      },
      body: JSON.stringify(body),
    });
  }
  async function model(providerId = "provider-1") {
    return proxyModel(await request(`model/${providerId}/chat/completions`), {
      params: Promise.resolve({ providerId, path: ["chat", "completions"] }),
    });
  }
  async function mcp(
    method: string,
    params?: object,
    deploymentId = "deployment-1",
  ) {
    return proxyMcp(
      await request(`mcp/${deploymentId}/rpc`, {
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params ? { params } : {}),
      }),
      { params: Promise.resolve({ deploymentId }) },
    );
  }

  it("rejects a provider outside the signed grant without reading provider credentials", async () => {
    expect((await model("other-provider")).status).toBe(403);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("uses the persisted revision and session mapping and strips caller credentials", async () => {
    const response = await model();
    expect(response.status).toBe(200);
    expect(mocks.revision).toHaveBeenCalledWith(
      expect.any(Object),
      "agent-1",
      "revision-1",
    );
    expect(mocks.conversation).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        agentId: "agent-1",
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        sandboxId: "sandbox-1",
      },
      select: { id: true },
    });
    expect(mocks.agent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runtimeKind: "pi-sdk",
          retiredAt: null,
          workspaceId: "workspace-1",
        }),
      }),
    );
    const headers = new Headers(mocks.fetch.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe("Bearer real-provider-key");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("data: chunk\n\n");
  });
  it.each(["revision", "agent", "session", "credential", "provider"])(
    "rejects live %s revocation before any upstream request",
    async (condition) => {
      if (condition === "revision")
        mocks.revision.mockRejectedValue(
          new Error("AGENT_REVISION_UNRESOLVED"),
        );
      if (condition === "agent") mocks.agent.mockResolvedValue(null);
      if (condition === "session") mocks.conversation.mockResolvedValue(null);
      if (condition === "credential")
        mocks.credentials.mockRejectedValue(
          new Error("AGENT_CREDENTIAL_REVOKED"),
        );
      if (condition === "provider")
        mocks.revision.mockResolvedValue({
          ...pin,
          config: { ...pin.config, providerId: "different-provider" },
        });
      expect((await model()).status).toBe(403);
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("does not widen a token to a revoked MCP deployment", async () => {
    mocks.agent.mockResolvedValue({ servers: [] });
    expect((await mcp("tools/list")).status).toBe(403);
    expect(mocks.listTools).not.toHaveBeenCalled();
  });
  it("never forwards a deployment outside the signed revision grant", async () => {
    expect((await mcp("tools/list", undefined, "unapproved")).status).toBe(403);
    expect(mocks.listTools).not.toHaveBeenCalled();
  });
  it("lists and calls tools through the isolated session broker, never shared process HTTP", async () => {
    const context = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      agentRevisionId: "revision-1",
      conversationId: "conversation-1",
    };
    const listed = await mcp("tools/list");
    expect(listed.status).toBe(200);
    expect(mocks.listTools).toHaveBeenCalledWith(context, "deployment-1");
    const called = await mcp("tools/call", {
      name: "read",
      arguments: { path: "report.txt" },
    });
    expect(called.status).toBe(200);
    expect(mocks.callTool).toHaveBeenCalledWith(
      context,
      "deployment-1",
      "read",
      { path: "report.txt" },
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects generic MCP execution methods", async () => {
    expect(
      (await mcp("resources/read", { uri: "file:///secret" })).status,
    ).toBe(403);
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["MCP_RUNTIME_FILES_CHANGED", "MCP_CREDENTIAL_REQUIRED"])(
    "classifies %s as a pre-effect denial, not unknown execution",
    async (code) => {
      mocks.callTool.mockRejectedValueOnce(new Error(code));
      const response = await mcp("tools/call", { name: "read", arguments: {} });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: -32003 } });
      expect(mocks.callTool).toHaveBeenCalledOnce();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("denies revoked tools and preserves unknown side effects without automatic retry", async () => {
    mocks.callTool.mockRejectedValueOnce(new Error("MCP_TOOL_FORBIDDEN"));
    expect((await mcp("tools/call", { name: "write" })).status).toBe(403);
    mocks.callTool.mockRejectedValueOnce(
      new Error("MCP_TOOL_EXECUTION_UNKNOWN"),
    );
    const response = await mcp("tools/call", { name: "read" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { data: { status: "execution_unknown" } },
    });
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
  });
});
