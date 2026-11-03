// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  agent: vi.fn(),
  conversation: vi.fn(),
  context: vi.fn(),
  sandbox: vi.fn(),
  provider: vi.fn(),
  revision: vi.fn(),
  credentials: vi.fn(),
  localToken: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  fetch: vi.fn(),
  logRequest: vi.fn(),
  subagentModels: vi.fn(),
  nativeModels: vi.fn(),
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
vi.mock("@/lib/agents/subagents", () => ({
  resolveAuthorizedSubagentModels: mocks.subagentModels,
}));
vi.mock("@/lib/agents/native-role-models", () => ({
  resolveNativeRoleModels: mocks.nativeModels,
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
    runtimeKind: "pi-sdk",
    model: "selected-model",
    providerId: "provider-1",
    mcpGrants: [{ deploymentId: "deployment-1", allowedToolNames: ["read"] }],
    externalSandboxes: [],
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

const nativeFetch = globalThis.fetch;

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
        sandbox: { findFirst: mocks.sandbox },
      }),
    );
    mocks.revision.mockResolvedValue(pin);
    mocks.subagentModels.mockResolvedValue([]);
    mocks.nativeModels.mockResolvedValue([]);
    mocks.agent.mockResolvedValue({
      servers: [{ deploymentId: "deployment-1", allowedToolNames: ["read"] }],
      externalSandboxes: [],
    });
    mocks.conversation.mockResolvedValue({ id: "conversation-1" });
    mocks.sandbox.mockResolvedValue({ config: {} });
    mocks.provider.mockResolvedValue({
      name: "OpenAI",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "real-provider-key",
      models: ["selected-model", "child-model", "role-model"],
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
    const headers = new Headers(mocks.fetch.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe("Bearer real-provider-key");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("data: chunk\n\n");
  });
  it("negotiates its own encoding and preserves real SSE bytes for a zstd-capable OMP client", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"OMP_OK"}}]}\n\ndata: [DONE]\n\n';
    // Fixed zstd frame: the repository's Node type definitions predate zstd APIs.
    const compressed = Buffer.from(
      "KLUv/SBCEQIAZGF0YTogeyJjaG9pY2VzIjpbeyJkZWx0YSI6eyJjb250ZW50IjoiT01QX09LIn19XX0KCmRhdGE6IFtET05FXQoK",
      "base64",
    );
    const encodings: string[] = [];
    const upstream = createServer((req, res) => {
      const encoding = req.headers["accept-encoding"] ?? "";
      encodings.push(encoding);
      res.setHeader("content-type", "text/event-stream");
      if (encoding.includes("zstd")) {
        res.setHeader("content-encoding", "zstd");
        res.end(compressed);
      } else {
        res.write(sse.slice(0, 20));
        res.end(sse.slice(20));
      }
    });
    const listening = Promise.withResolvers<void>();
    upstream.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("No upstream address");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const compressedResponse = await nativeFetch(
        `${baseUrl}/chat/completions`,
        {
          headers: { "accept-encoding": "gzip, deflate, br, zstd" },
        },
      );
      expect(compressedResponse.headers.get("content-encoding")).toBe("zstd");
      await compressedResponse.arrayBuffer();
      mocks.provider.mockResolvedValue({
        format: "openai",
        baseUrl,
        apiKey: "real-provider-key",
        models: ["selected-model"],
      });
      mocks.revision.mockResolvedValue({
        ...pin,
        config: { ...pin.config, runtimeKind: "omp" },
      });
      vi.stubGlobal("fetch", nativeFetch);
      const req = await request("model/provider-1/chat/completions", {
        model: "selected-model",
        stream: true,
        messages: [],
      });
      req.headers.set("accept-encoding", "gzip, deflate, br, zstd");
      const response = await proxyModel(req, {
        params: Promise.resolve({
          providerId: "provider-1",
          path: ["chat", "completions"],
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("content-encoding")).toBeNull();
      await expect(response.text()).resolves.toBe(sse);
      expect(encodings).toEqual(["gzip, deflate, br, zstd", "identity"]);
    } finally {
      upstream.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      upstream.close(() => closed.resolve());
      await closed.promise;
    }
  });
  it("restricts OMP child and auxiliary model requests to the admitted model", async () => {
    mocks.revision.mockResolvedValue({
      ...pin,
      config: { ...pin.config, runtimeKind: "omp" },
    });
    const invoke = async (body: unknown) =>
      proxyModel(await request("model/provider-1/chat/completions", body), {
        params: Promise.resolve({
          providerId: "provider-1",
          path: ["chat", "completions"],
        }),
      });
    expect((await invoke({ model: "unapproved-model" })).status).toBe(403);
    expect((await invoke({})).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(
      (await invoke({ model: "selected-model", messages: [] })).status,
    ).toBe(200);
    expect(
      new Headers(mocks.fetch.mock.calls[0][1].headers).get("authorization"),
    ).toBe("Bearer real-provider-key");
  });
  it("permits only pinned live child provider/model pairs and stops after revocation", async () => {
    mocks.revision.mockResolvedValue({
      ...pin,
      config: {
        ...pin.config,
        runtimeKind: "omp",
        subagents: [
          { subagentId: "child", versionId: "child-v1", checksum: "fixed" },
        ],
      },
    });
    mocks.subagentModels.mockResolvedValue([
      { providerId: "child-provider", model: "child-model" },
    ]);
    const invoke = async (providerId: string, model: string) =>
      proxyModel(
        await request(`model/${providerId}/chat/completions`, {
          model,
          messages: [],
        }),
        {
          params: Promise.resolve({
            providerId,
            path: ["chat", "completions"],
          }),
        },
      );
    expect((await invoke("child-provider", "unapproved-model")).status).toBe(
      403,
    );
    expect((await invoke("other-provider", "child-model")).status).toBe(403);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    const response = await invoke("child-provider", "child-model");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("data: chunk\n\n");
    mocks.subagentModels.mockResolvedValue([]);
    mocks.fetch.mockClear();
    expect((await invoke("child-provider", "child-model")).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("permits mapped native role models only while the frozen role and live catalog grants agree", async () => {
    mocks.revision.mockResolvedValue({
      ...pin,
      config: {
        ...pin.config,
        runtimeKind: "omp",
        subagentMode: "native",
        nativeRoleModels: [
          { providerId: "role-provider", model: "role-model" },
        ],
      },
    });
    mocks.nativeModels.mockResolvedValue([
      { providerId: "role-provider", model: "role-model" },
    ]);
    const invoke = async (providerId: string, model: string) =>
      proxyModel(
        await request(`model/${providerId}/chat/completions`, {
          model,
          messages: [],
        }),
        {
          params: Promise.resolve({
            providerId,
            path: ["chat", "completions"],
          }),
        },
      );
    expect((await invoke("foreign-provider", "role-model")).status).toBe(403);
    expect((await invoke("role-provider", "unreviewed-model")).status).toBe(
      403,
    );
    expect((await invoke("role-provider", "role-model")).status).toBe(200);
    mocks.fetch.mockClear();
    mocks.nativeModels.mockResolvedValue([]);
    expect((await invoke("role-provider", "role-model")).status).toBe(403);
    mocks.nativeModels.mockResolvedValue([
      { providerId: "role-provider", model: "role-model" },
    ]);
    mocks.provider.mockResolvedValue({
      name: "Role",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "key",
      models: [],
    });
    expect((await invoke("role-provider", "role-model")).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
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
    mocks.agent.mockResolvedValue({ servers: [], externalSandboxes: [] });
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
      // The fixed denial code lets the Pi bridge tell the user why the server failed.
      expect(await response.json()).toMatchObject({
        error: { code: -32003, data: { reason: code } },
      });
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
  it("explains why discovery was denied so the session failure names the cause", async () => {
    mocks.listTools.mockRejectedValueOnce(new Error("MCP_TOOL_FORBIDDEN"));
    const response = await mcp("tools/list");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { data: { reason: "MCP_TOOL_FORBIDDEN" } },
    });
  });
});
