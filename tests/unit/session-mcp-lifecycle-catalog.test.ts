import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  conversation: vi.fn(),
  revision: vi.fn(),
  binding: vi.fn(),
  deployment: vi.fn(),
  persistedDeployment: vi.fn(),
  files: vi.fn(),
  resolve: vi.fn(),
  start: vi.fn(),
  user: vi.fn(),
  workspace: vi.fn(),
  sandbox: vi.fn(),
  prepare: vi.fn(),
  stop: vi.fn(),
  save: vi.fn(),
  query: vi.fn(),
  pinUpdate: vi.fn(),
  transactionDepth: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const client = {
    user: { findFirst: mocks.user },
    workspace: { findFirst: mocks.workspace },
    agent: { findFirst: mocks.agent },
    conversation: { findFirst: mocks.conversation },
    agentRevision: { findFirst: mocks.revision },
    agentSandbox: { findFirst: mocks.sandbox },
    agentServer: { findUnique: mocks.binding },
    deployment: {
      findFirst: mocks.deployment,
      findUnique: mocks.persistedDeployment,
      update: mocks.save,
      updateMany: mocks.pinUpdate,
    },
    deploymentConfigFile: { findMany: mocks.files },
    $queryRaw: mocks.query,
  };
  return {
    db: {
      ...client,
      $transaction: async (
        operation: (tx: typeof client) => Promise<unknown>,
      ) => {
        mocks.transactionDepth += 1;
        try {
          return await operation(client);
        } finally {
          mocks.transactionDepth -= 1;
        }
      },
    },
  };
});
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  beginRuntimeOperation: () => () => undefined,
  runtimeAbortSignal: () => undefined,
}));
vi.mock("@/lib/agents/revision-types", () => ({
  AgentRevisionConfigSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/agents/environment-credentials", () => ({
  assertAgentEnvironmentCredentialReferences: vi.fn(),
}));
vi.mock("@/lib/pi-packages/revocation", () => ({
  assertMarketReleasesExecutable: vi.fn(),
}));
vi.mock("@/lib/process/mcp-credentials", () => ({
  resolveMcpConnectionSpawnSpec: mocks.resolve,
  resolveMcpEnvironment: () => ({}),
}));
vi.mock("@/lib/process/mcp-runtime-image", () => ({
  sessionMcpPackageLaunch: () => null,
  validateSessionMcpRuntimeImage: vi.fn(),
  prepareSessionMcpRuntimeImage: mocks.prepare,
}));
vi.mock("@/lib/process/supervisor", () => ({
  startProcess: mocks.start,
  stopProcess: mocks.stop,
  livePort: () => 4321,
  liveRedactionValues: () => ["session-private-token"],
  mcpRuntimeCredentialIdentity: () => "launch-private-mac",
  liveMcpRuntimeSnapshot: () => ({
    port: 4321,
    generation: "session-generation",
    credentialIdentity: "launch-private-mac",
    redactionValues: ["session-private-token"],
  }),
}));
vi.mock("@/lib/observability/events", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/process/mcp-grant-sync", () => ({
  syncDeploymentMcpGrants: vi.fn(),
}));
import {
  callSessionMcpTool,
  listSessionMcpTools,
  sessionMcpProcessId,
} from "@/lib/process/session-mcp";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesIdentity,
} from "@/lib/process/mcp-definition";
import { persistDeploymentMcpToolCatalog } from "@/lib/process/mcp-tool-catalog-store";
import { inspectAgentMcpConnection } from "@/lib/process/agent-mcp-inspection";

const image = `sha256:${"a".repeat(64)}`;
const context = {
  workspaceId: "workspace",
  agentId: "agent",
  agentRevisionId: "revision",
  conversationId: "conversation",
};
const recipe = {
  id: "source-deployment",
  workspaceId: "workspace",
  name: "Docker MCP",
  serverId: null,
  source: "docker",
  sourceRef: image,
  installCfg: { env: {} },
  status: "stopped",
  mcpToolExposure: "all",
  mcpAllowedTools: [],
};
const approved = {
  name: "approved",
  description: "session-private-token",
  inputSchema: { type: "object" },
};

function rpcResult(result: Record<string, unknown>) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });
}

// Exercise the real SDK client, including initialization, notification GET,
// protocol headers and teardown. Record business requests separately so the
// assertions describe catalog pagination and dispatch, not HTTP packet counts.
function sessionBridge(
  reply: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>,
) {
  const sessions = new Map<string, string>();
  const business = vi.fn(reply);
  const http = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:4321/session");
      const headers = new Headers(init?.headers);
      const owner = headers.get("x-toolplane-mcp-owner");
      const session = headers.get("mcp-session-id");
      if (!owner) throw new Error("Missing session owner");
      if (!session) {
        const msg = JSON.parse(String(init?.body));
        expect(msg.method).toBe("initialize");
        expect(msg.params.capabilities).toMatchObject({
          roots: {},
          sampling: {},
          elicitation: {},
        });
        const id = crypto.randomUUID();
        sessions.set(id, owner);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "catalog", version: "1" },
            },
          },
          { headers: { "mcp-session-id": id } },
        );
      }
      expect(sessions.get(session)).toBe(owner);
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") {
        sessions.delete(session);
        return new Response(null, { status: 200 });
      }
      const msg = JSON.parse(String(init?.body));
      if (msg.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: business(msg.method, msg.params ?? {}),
      });
    });
  return { http, business, sessions };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockResolvedValue({ id: "agent", currentRevisionVersion: 1 });
  mocks.conversation.mockResolvedValue({ id: "conversation" });
  mocks.binding.mockResolvedValue({ allowedToolNames: ["approved"] });
  mocks.deployment.mockResolvedValue(recipe);
  mocks.persistedDeployment.mockResolvedValue(null);
  mocks.files.mockResolvedValue([]);
  mocks.user.mockReset().mockResolvedValue({ role: "member" });
  mocks.workspace.mockReset().mockResolvedValue({ id: "workspace" });
  mocks.sandbox.mockReset().mockResolvedValue({ sandboxId: "sandbox" });
  mocks.prepare.mockReset().mockResolvedValue(image);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.save.mockReset().mockResolvedValue({});
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.pinUpdate.mockReset().mockResolvedValue({ count: 1 });
  mocks.transactionDepth = 0;
  mocks.revision.mockResolvedValue({
    config: {
      packages: [],
      sandboxTemplateId: "sandbox",
      environment: { credentialReferences: [] },
      mcpGrants: [
        {
          deploymentId: recipe.id,
          definitionChecksum: mcpDefinitionChecksum(recipe),
          runtimeFilesChecksum: mcpRuntimeFilesIdentity([]),
          runtimeImageDigest: image,
          allowedToolNames: ["approved"],
        },
      ],
    },
  });
  mocks.resolve.mockImplementation(async () => ({
    spec: {
      kind: "bridge",
      name: "Docker MCP",
      command: "docker",
      image,
      args: ["run", "--rm", image],
      env: {},
      containerEnv: { TOKEN: "session-private-token" },
    },
    redactionValues: ["session-private-token"],
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("session catalog without a Deployment row", () => {
  it("returns and redacts the actual paginated catalog without persisting a synthetic process ID", async () => {
    const processId = sessionMcpProcessId(context, recipe.id);
    // Exercise the real persistence boundary that cannot store this process ID.
    await expect(
      persistDeploymentMcpToolCatalog(processId, [approved]),
    ).resolves.toEqual([]);
    mocks.persistedDeployment.mockClear();
    const bridge = sessionBridge((_method, params) =>
      params.cursor === "second"
        ? { tools: [approved] }
        : {
            tools: [
              { name: "newly_discovered", inputSchema: { type: "object" } },
            ],
            nextCursor: "second",
          },
    );

    const tools = await listSessionMcpTools(context, recipe.id);
    expect(tools).toEqual([{ ...approved, description: "[REDACTED]" }]);
    expect(JSON.stringify(tools)).not.toContain("session-private-token");
    expect(mocks.persistedDeployment).not.toHaveBeenCalled();
    expect(bridge.business.mock.calls).toEqual([
      ["tools/list", {}],
      ["tools/list", { cursor: "second" }],
    ]);
    expect(bridge.sessions.size).toBe(0);
  });

  it("dispatches an approved second-page tool through the real RPC client", async () => {
    const bridge = sessionBridge((method, params) => {
      if (method === "tools/call")
        return { content: [{ type: "text", text: "ok" }] };
      return params.cursor === "second"
        ? { tools: [approved] }
        : { tools: [], nextCursor: "second" };
    });

    await expect(
      callSessionMcpTool(context, recipe.id, "approved", {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(bridge.business.mock.calls).toEqual([
      ["tools/list", {}],
      ["tools/list", { cursor: "second" }],
      ["tools/call", { name: "approved", arguments: {} }],
    ]);
    expect(mocks.persistedDeployment).not.toHaveBeenCalled();
  });

  it("does not grant a newly discovered name", async () => {
    const bridge = sessionBridge(() => ({
      tools: [
        approved,
        { name: "newly_discovered", inputSchema: { type: "object" } },
      ],
    }));
    await expect(listSessionMcpTools(context, recipe.id)).resolves.toHaveLength(
      1,
    );
    bridge.http.mockClear();
    await expect(
      callSessionMcpTool(context, recipe.id, "newly_discovered", {}),
    ).rejects.toThrow("MCP_TOOL_FORBIDDEN");
    expect(bridge.http).not.toHaveBeenCalled();
  });

  it("never returns a partial session catalog for a repeated pagination cursor", async () => {
    const bridge = sessionBridge(() => ({
      tools: [approved],
      nextCursor: "again",
    }));
    await expect(listSessionMcpTools(context, recipe.id)).resolves.toEqual([]);
    expect(bridge.business.mock.calls).toEqual([
      ["tools/list", {}],
      ["tools/list", { cursor: "again" }],
    ]);
    expect(mocks.persistedDeployment).not.toHaveBeenCalled();
  });
});

describe("Agent target controlled MCP inspection", () => {
  const input = {
    workspaceId: "workspace",
    agentId: "agent",
    agentRevisionId: "revision",
    deploymentId: recipe.id,
    userId: "owner",
  };

  it("discovers a stopped recipe through disposable instances and saves only redacted catalog evidence", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => rpcResult({ tools: [approved] }));
    const first = await inspectAgentMcpConnection(input);
    const second = await inspectAgentMcpConnection(input);
    expect(first).toMatchObject({
      tools: [{ name: "approved" }],
      sandboxId: "sandbox",
      definitionChecksum: mcpDefinitionChecksum(recipe),
      runtimeFilesChecksum: mcpRuntimeFilesIdentity([]),
    });
    expect(JSON.stringify(first)).not.toContain("session-private-token");
    expect(Number.isFinite(Date.parse(second.connectedAt))).toBe(true);
    const ids = mocks.start.mock.calls.map(([id]) => id);
    expect(ids[0]).toMatch(/^session-mcp-inspection-/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(mocks.stop.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => JSON.parse(String(init?.body)).method === "tools/list",
      ),
    ).toBe(true);
    expect(mocks.binding).not.toHaveBeenCalled();
    expect(mocks.persistedDeployment).not.toHaveBeenCalled();
    for (const [update] of mocks.save.mock.calls) {
      expect(Object.keys(update.data)).toEqual(["installCfg"]);
      expect(update.data.installCfg.mcpInspector).toMatchObject({
        sandboxId: "sandbox",
        definitionChecksum: first.definitionChecksum,
        runtimeFilesChecksum: first.runtimeFilesChecksum,
      });
      expect(JSON.stringify(update.data.installCfg)).not.toContain(
        "session-private-token",
      );
    }
  });

  it.each(["actor", "workspace", "revision", "sandbox"] as const)(
    "refuses a missing %s before preparation, credentials, or startup",
    async (missing) => {
      if (missing === "actor") mocks.user.mockResolvedValue(null);
      if (missing === "workspace") mocks.workspace.mockResolvedValue(null);
      if (missing === "revision") mocks.revision.mockResolvedValue(null);
      if (missing === "sandbox") mocks.sandbox.mockResolvedValue(null);
      await expect(inspectAgentMcpConnection(input)).rejects.toThrow();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("rechecks authority after artifact preparation before resolving secrets", async () => {
    mocks.user
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce(null);
    await expect(inspectAgentMcpConnection(input)).rejects.toThrow(
      "MCP_CONNECTION_NOT_AUTHORIZED",
    );
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("pins a floating npm recipe before discovery checksums and keeps registry calls outside transactions", async () => {
    let deployment = {
      ...recipe,
      source: "npm",
      sourceRef: "@fixture/inspection-mcp",
      installCfg: { env: { KEEP: "preserved" } },
      updatedAt: new Date(),
    };
    mocks.deployment.mockImplementation(async () => deployment);
    mocks.pinUpdate.mockImplementation(async ({ data }) => {
      deployment = { ...deployment, ...data };
      return { count: 1 };
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).startsWith("https://registry.npmjs.org/")) {
        expect(mocks.transactionDepth).toBe(0);
        return new Response(
          JSON.stringify({ "dist-tags": { latest: "3.2.1" } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return rpcResult({ tools: [approved] });
    });
    const inspected = await inspectAgentMcpConnection(input);
    expect(deployment.sourceRef).toBe("@fixture/inspection-mcp@3.2.1");
    expect(inspected.definitionChecksum).toBe(
      mcpDefinitionChecksum(deployment),
    );
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      sourceRef: deployment.sourceRef,
    });
    expect(deployment.installCfg).toEqual({ env: { KEEP: "preserved" } });
    expect(
      mocks.save.mock.calls[0][0].data.installCfg.mcpInspector
        .definitionChecksum,
    ).toBe(inspected.definitionChecksum);
  });

  it("reports resolution failures without preparing an image, resolving secrets, or starting an instance", async () => {
    mocks.deployment.mockResolvedValue({
      ...recipe,
      source: "npm",
      sourceRef: "@fixture/unavailable",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private upstream failure"),
    );
    await expect(inspectAgentMcpConnection(input)).rejects.toMatchObject({
      code: "mcpVersionResolutionFailed",
      message: "mcpVersionResolutionFailed",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rechecks authority after pinning before preparing an artifact", async () => {
    mocks.user
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce(null);
    await expect(inspectAgentMcpConnection(input)).rejects.toThrow(
      "MCP_CONNECTION_NOT_AUTHORIZED",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects malformed catalogs rather than saving an empty successful receipt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      rpcResult({ tools: "invalid" }),
    );
    await expect(inspectAgentMcpConnection(input)).rejects.toThrow(
      "MCP_CATALOG_INVALID",
    );
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not save successful discovery if private cleanup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      rpcResult({ tools: [approved] }),
    );
    mocks.stop.mockRejectedValueOnce(new Error("private projection busy"));
    await expect(inspectAgentMcpConnection(input)).rejects.toThrow(
      "private projection busy",
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("stops the inspection and discards its receipt if the applied revision changes before the final locked write", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      rpcResult({ tools: [approved] }),
    );
    mocks.query.mockImplementationOnce(async () => {
      mocks.revision.mockResolvedValue(null);
      return [];
    });
    await expect(inspectAgentMcpConnection(input)).rejects.toThrow(
      "AGENT_REVISION_CONFLICT",
    );
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
