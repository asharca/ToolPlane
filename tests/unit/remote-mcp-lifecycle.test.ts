import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  snapshot: vi.fn(),
  start: vi.fn(),
  rpc: vi.fn(),
  operation: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { deployment: { findFirst: mocks.deployment } },
}));
vi.mock("@/lib/process/supervisor", () => ({
  liveMcpRuntimeSnapshot: mocks.snapshot,
  startProcess: mocks.start,
}));
vi.mock("@/lib/process/mcp-client", () => ({ mcpRpc: mocks.rpc }));
vi.mock("@/lib/workspace/mcp-operation", () => ({
  runMcpDeploymentOperation: mocks.operation,
}));
import {
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import {
  mcpDefinitionChecksum,
  prepareSessionMcpDefinition,
} from "@/lib/process/mcp-definition";
import {
  callPinnedRemoteMcpTool,
  McpToolNotDispatchedError,
  listPinnedRemoteMcpTools,
} from "@/lib/remote-mcp/pinned-connection";
import {
  assertAssistantRemoteDeployment,
  remoteMcpConnectionIdentity,
} from "@/lib/remote-mcp/classification";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import {
  parseMcpJsonConfig,
  parseCustomMcpInput,
  parseMcpDeploymentConfig,
  serializeMcpDeploymentConfig,
} from "@/lib/workspace/custom-mcp";
import { isValidRemoteMcpUrl } from "@/lib/remote-mcp/url";
import { recipeToDeploymentData } from "@/lib/workspace/server-recipe";
import {
  readMcpInspectorConnection,
  withMcpInspectorConnection,
} from "@/lib/workspace/inspector-connection";

const remote = {
  serverId: null,
  name: "Remote",
  source: "remote",
  sourceRef: "https://mcp.example.com/mcp",
  installCfg: { transport: "streamable-http", authType: "none", env: {} },
};

it("does not inherit unsafe HTTP consent from an imported package or JSON document", () => {
  const config = JSON.stringify({
    mcpServers: {
      remote: {
        type: "http",
        url: "http://mcp.example.com/mcp",
        allowUnsafeHttp: true,
      },
    },
  });
  expect(() => parseCustomMcpInput({ source: "config", config })).toThrow(
    "HTTP is unencrypted",
  );
  expect(
    parseCustomMcpInput({ source: "config", config, allowUnsafeHttp: true }),
  ).toMatchObject({ installCfg: { allowUnsafeHttp: true } });
  const recipe = {
    source: "remote" as const,
    ref: "http://mcp.example.com/mcp",
    env: [],
    allowUnsafeHttp: true,
  };
  expect(recipeToDeploymentData(recipe).installCfg.allowUnsafeHttp).toBe(false);
  expect(
    recipeToDeploymentData(recipe, { allowUnsafeHttp: true }).installCfg
      .allowUnsafeHttp,
  ).toBe(true);
});

it("does not accept an imported HTTP flag as config-editor operator consent", () => {
  const config = JSON.stringify({
    type: "http",
    url: "http://mcp.example.com/mcp",
    allowUnsafeHttp: true,
  });
  expect(() =>
    parseMcpDeploymentConfig(config, "remote", "Remote", undefined, {
      allowEnvironment: false,
      allowUnsafeHttp: false,
    }),
  ).toThrow("HTTP is unencrypted");
  expect(
    parseMcpDeploymentConfig(config, "remote", "Remote", undefined, {
      allowEnvironment: false,
      allowUnsafeHttp: true,
    }),
  ).toMatchObject({ source: "remote", installCfg: { allowUnsafeHttp: true } });
});

it("keeps remote editor credentials as references rather than leaking secret values", () => {
  const serialized = serializeMcpDeploymentConfig({
    ...remote,
    installCfg: sealMcpEnvironment(
      { ...remote.installCfg, authType: "bearer", bearerEnv: "TOKEN" },
      "workspace",
      { TOKEN: "private-token" },
    ),
  });
  expect(serialized).not.toContain("private-token");
  expect(serialized).toContain(`\${TOKEN}`);
  expect(
    parseMcpDeploymentConfig(serialized, "remote", "Remote", undefined, {
      allowEnvironment: false,
    }),
  ).toMatchObject({
    installCfg: { env: {}, bearerEnv: "TOKEN", requiredEnv: ["TOKEN"] },
  });
  expect(() =>
    parseMcpDeploymentConfig(
      JSON.stringify({
        type: "http",
        url: remote.sourceRef,
        headers: { Authorization: "Bearer private-token" },
      }),
      "remote",
      "Remote",
      undefined,
      { allowEnvironment: false },
    ),
  ).toThrow("Variables");
});

it("preserves custom credential references while refusing reserved protocol headers", () => {
  const deployment = {
    ...remote,
    installCfg: sealMcpEnvironment(
      {
        ...remote.installCfg,
        authType: "headers",
        headerEnv: { Authorization: "AUTH_VALUE" },
      },
      "workspace",
      { AUTH_VALUE: "Basic private-value" },
    ),
  };
  const serialized = serializeMcpDeploymentConfig(deployment);
  expect(serialized).not.toContain("private-value");
  expect(
    parseMcpDeploymentConfig(serialized, "remote", "Remote", undefined, {
      allowEnvironment: false,
    }),
  ).toMatchObject({
    installCfg: {
      env: {},
      authType: "headers",
      headerEnv: { Authorization: "AUTH_VALUE" },
    },
  });
  for (const header of [
    "Host",
    "Mcp-Session-Id",
    "Content-Length",
    "constructor",
  ]) {
    expect(() =>
      parseMcpDeploymentConfig(
        JSON.stringify({
          type: "http",
          url: remote.sourceRef,
          headers: { [header]: `\${TOKEN}` },
        }),
        "remote",
        "Remote",
        undefined,
        { allowEnvironment: false },
      ),
    ).toThrow("allowed header names");
  }
});

it("does not trust historical discovery receipts lacking recipe and managed-file pins", () => {
  expect(
    readMcpInspectorConnection({
      mcpInspector: {
        sandboxId: "sandbox",
        connectedAt: "2026-10-23T00:00:00Z",
      },
    }),
  ).toBeNull();
  const pin = {
    definitionChecksum: "a".repeat(64),
    runtimeFilesChecksum: "b".repeat(64),
  };
  expect(
    readMcpInspectorConnection(
      withMcpInspectorConnection({}, [], "sandbox", pin),
    ),
  ).toMatchObject(pin);
});

it("distinguishes resolved credential rotations using a process-private identity", () => {
  const cfg = sealMcpEnvironment(
    { ...remote.installCfg, authType: "bearer", bearerEnv: "TOKEN" },
    "workspace",
    { TOKEN: "old-token" },
  );
  const rotated = sealMcpEnvironment(cfg, "workspace", { TOKEN: "new-token" });
  const first = resolveSpawnSpec({
    ...remote,
    installCfg: { ...cfg, env: resolveMcpEnvironment(cfg, "workspace") },
  });
  const second = resolveSpawnSpec({
    ...remote,
    installCfg: {
      ...rotated,
      env: resolveMcpEnvironment(rotated, "workspace"),
    },
  });
  if (first.kind !== "remote" || second.kind !== "remote")
    throw new Error("remote fixture required");
  expect(remoteMcpConnectionIdentity(first)).not.toBe(
    remoteMcpConnectionIdentity(second),
  );
  expect(remoteMcpConnectionIdentity(first)).toBe(
    remoteMcpConnectionIdentity(first),
  );
  const publicDigest = createHash("sha256")
    .update(
      JSON.stringify({
        url: first.url,
        transport: first.transport,
        timeoutMs: first.timeoutMs,
        allowUnsafeHttp: first.allowUnsafeHttp,
        headers: Object.entries(first.headers ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    )
    .digest("hex");
  expect(remoteMcpConnectionIdentity(first)).not.toBe(publicDigest);
  expect(mcpDefinitionChecksum({ ...remote, installCfg: cfg })).toBe(
    mcpDefinitionChecksum({ ...remote, installCfg: rotated }),
  );
});

it("classifies and prepares sealed remote recipes from metadata without decrypting credentials", async () => {
  const cfg = sealMcpEnvironment(
    { ...remote.installCfg, authType: "bearer", bearerEnv: "TOKEN" },
    "workspace",
    { TOKEN: "private-token" },
  );
  const deployment = {
    ...remote,
    installCfg: {
      ...cfg,
      credentialEnvelope: { configuredKeys: ["TOKEN"], encrypted: null },
    },
  };
  expect(assertAssistantRemoteDeployment(deployment)).toMatchObject({
    kind: "remote",
    headers: { authorization: "Bearer configured" },
  });
  await expect(prepareSessionMcpDefinition(deployment)).resolves.toEqual({
    definitionChecksum: mcpDefinitionChecksum(deployment),
    runtimeImageDigest: null,
  });
});

describe("remote MCP explicit transport authorization", () => {
  it("requires a separate plaintext-risk approval, not merely an HTTP URL", () => {
    expect(() =>
      resolveSpawnSpec({ ...remote, sourceRef: "http://mcp.example.com/mcp" }),
    ).toThrow("explicit plaintext-risk approval");
    expect(
      resolveSpawnSpec({
        ...remote,
        sourceRef: "http://mcp.example.com/mcp",
        installCfg: { ...remote.installCfg, allowUnsafeHttp: true },
      }),
    ).toMatchObject({
      kind: "remote",
      url: "http://mcp.example.com/mcp",
      allowUnsafeHttp: true,
    });
    expect(() =>
      resolveSpawnSpec({
        ...remote,
        sourceRef: "http://mcp.example.com/mcp",
        installCfg: { ...remote.installCfg, allowUnsafeHttp: "true" },
      }),
    ).toThrow("explicit plaintext-risk approval");
  });

  it("retains explicitly chosen SSE without downgrading HTTPS", () => {
    expect(
      resolveSpawnSpec({
        ...remote,
        installCfg: { ...remote.installCfg, transport: "sse" },
      }),
    ).toMatchObject({
      kind: "remote",
      transport: "sse",
      url: "https://mcp.example.com/mcp",
    });
    expect(() =>
      resolveSpawnSpec({
        ...remote,
        installCfg: { ...remote.installCfg, transport: "auto" },
      }),
    ).toThrow("transport");
  });

  it("keeps unsafe HTTP approval explicit through JSON import", () => {
    expect(() =>
      parseMcpJsonConfig(
        JSON.stringify({ type: "http", url: "http://mcp.example.com/mcp" }),
        "remote",
      ),
    ).toThrow("allowUnsafeHttp");
    expect(
      parseMcpJsonConfig(
        JSON.stringify({
          type: "sse",
          url: "http://mcp.example.com/mcp",
          allowUnsafeHttp: true,
        }),
        "remote",
      ),
    ).toMatchObject({
      source: "remote",
      installCfg: { transport: "sse", allowUnsafeHttp: true },
    });
  });

  it("never allows URL credentials, query tokens, fragments or metadata targets", () => {
    for (const url of [
      "https://user:secret@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?token=secret",
      "https://mcp.example.com/mcp#secret",
      "http://169.254.169.254/mcp",
      "https://localhost/mcp",
      "https://[::1]/mcp",
    ]) {
      expect(isValidRemoteMcpUrl(url)).toBe(false);
      expect(() =>
        resolveSpawnSpec({
          ...remote,
          sourceRef: url,
          installCfg: { ...remote.installCfg, allowUnsafeHttp: true },
        }),
      ).toThrow();
    }
  });

  it("rejects stdio and internal Agent gateways for Assistant consumers", () => {
    expect(() =>
      assertAssistantRemoteDeployment({
        ...remote,
        source: "config",
        installCfg: {
          command: "npx",
          args: ["-y", "example-mcp@1.0.0"],
          env: {},
        },
      }),
    ).toThrow("ASSISTANT_REMOTE_MCP_REQUIRED");
    for (const path of [
      "/mcp/private-session/rpc",
      "/api/v1/agents/secret/rpc",
      "/a2a/secret",
      "/%6dcp/private-session/rpc",
      "/api/v1/pi-packages/installations/private-client/mcp",
      "/api/v1/pi-packages/installations/private-client/mcp/",
      "/api/v1/%70i-packages/%69nstallations/private-client/%6dcp",
      "/api/v1/sandboxes/private-sandbox/mcp",
      "/api/v1/agent-runtimes/private-runtime/mcp",
      "/api/v1/agent-runtime/mcp/private-deployment/rpc",
      "/api/v1/workspaces/private-workspace/toolkits/private-toolkit/mcp",
      "/api/v1/workspaces/private-workspace/agents/mcp",
      "/api/v1/agent-endpoints/private-endpoint/a2a/mcp",
    ]) {
      expect(() =>
        assertAssistantRemoteDeployment({
          ...remote,
          sourceRef: `https://mcp.example.com${path}`,
        }),
      ).toThrow("ASSISTANT_REMOTE_MCP_REQUIRED");
    }
    expect(assertAssistantRemoteDeployment(remote).transport).toBe(
      "streamable-http",
    );
  });
});

describe("pinned remote credential access", () => {
  function fixture(token = "private-token") {
    return {
      ...remote,
      id: "remote",
      workspaceId: "workspace",
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["read"],
      installCfg: sealMcpEnvironment(
        {
          ...remote.installCfg,
          authType: "bearer",
          bearerEnv: "TOKEN",
          requiredEnv: ["TOKEN"],
        },
        "workspace",
        { TOKEN: token },
      ),
    };
  }

  function context(deployment = fixture()) {
    return {
      workspaceId: "workspace",
      deploymentId: deployment.id,
      definitionChecksum: mcpDefinitionChecksum(deployment),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.deployment.mockResolvedValue(fixture());
    mocks.operation.mockImplementation(
      async (_workspaceId, _deploymentId, operation) => ({
        accepted: true,
        value: await operation(),
      }),
    );
    mocks.start.mockImplementation(async (_id, spec) => {
      mocks.snapshot.mockReturnValue({
        remoteConnectionIdentity: remoteMcpConnectionIdentity(spec),
      });
    });
    mocks.rpc.mockResolvedValue({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    });
  });

  it("preserves a real remote launch identity across discovery and a fresh route module while still refusing rotation", async () => {
    let effects = 0;
    mocks.snapshot.mockReturnValue(undefined);
    mocks.rpc.mockImplementation(async (_id, method) => {
      if (method === "tools/call") {
        effects += 1;
        return { content: [{ type: "text", text: "approved effect" }] };
      }
      return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
    });
    const pinned = context();
    await expect(listPinnedRemoteMcpTools(pinned)).resolves.toMatchObject([
      { name: "read" },
    ]);

    // Intentionally reload the module boundary: Next route bundles/reloads must
    // compare against the launch retained in the process-global supervisor.
    vi.resetModules();
    const freshRoute = await import("@/lib/remote-mcp/pinned-connection");
    await expect(
      freshRoute.listPinnedRemoteMcpTools(pinned),
    ).resolves.toMatchObject([{ name: "read" }]);
    await expect(
      freshRoute.callPinnedRemoteMcpTool(pinned, "read", {}, ["read"]),
    ).resolves.toEqual({
      content: [{ type: "text", text: "approved effect" }],
    });
    expect(effects).toBe(1);

    mocks.deployment.mockResolvedValue(fixture("rotated-private-token"));
    await expect(
      freshRoute.callPinnedRemoteMcpTool(pinned, "read", {}, ["read"]),
    ).rejects.toThrow("MCP_CONNECTION_RESTART_REQUIRED");
    expect(effects).toBe(1);
  });

  it("lazily restarts a stopped remote connection with the current rotated credentials", async () => {
    const rotated = fixture("rotated-private-token");
    mocks.deployment.mockResolvedValue(rotated);
    mocks.snapshot.mockReturnValue(null);
    await expect(
      listPinnedRemoteMcpTools(context(rotated)),
    ).resolves.toMatchObject([{ name: "read" }]);
    expect(mocks.start).toHaveBeenCalledWith(
      "remote",
      expect.objectContaining({
        headers: { authorization: "Bearer rotated-private-token" },
      }),
      { workspaceId: "workspace" },
    );
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });

  it("classifies revoked final authorization as not dispatched and preserves its cause", async () => {
    const refusal = new Error("Assistant MCP grant was revoked");
    const beforeCall = vi.fn(async () => {
      throw refusal;
    });

    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"], {}, beforeCall),
    ).rejects.toMatchObject({
      name: "McpToolNotDispatchedError",
      cause: refusal,
    });
    expect(beforeCall).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "remote",
      "tools/list",
      {},
      5_000,
      expect.objectContaining({
        maxResponseBytes: 4_000_000,
        onResponseBytes: expect.any(Function),
      }),
    );
  });

  it("does not classify transport loss after tools/call as a known refusal", async () => {
    const lost = new Error("Connection lost after remote commit");
    mocks.rpc.mockImplementation(async (_id, method) => {
      if (method === "tools/list") {
        return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
      }
      throw lost;
    });

    const outcome = callPinnedRemoteMcpTool(context(), "read", {}, ["read"]);
    await expect(outcome).rejects.toBe(lost);
    await expect(outcome).rejects.not.toBeInstanceOf(McpToolNotDispatchedError);
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "remote",
      "tools/call",
      { name: "read", arguments: {} },
      30_000,
      {},
    );
  });

  it("discovers all pages and permits an approved tool found only on a later page", async () => {
    mocks.rpc.mockImplementation(async (_id, method, params) => {
      if (method === "tools/call")
        return { content: [{ type: "text", text: "ok" }] };
      return params.cursor === "next"
        ? {
            tools: [
              {
                name: "read",
                description: "private-token",
                inputSchema: { type: "object" },
              },
            ],
          }
        : {
            tools: [{ name: "first", inputSchema: { type: "object" } }],
            nextCursor: "next",
          };
    });
    const catalog = await listPinnedRemoteMcpTools(context());
    expect(catalog.map((tool) => tool.name)).toEqual(["first", "read"]);
    expect(JSON.stringify(catalog)).not.toContain("private-token");
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(5);
    expect(
      mocks.rpc.mock.calls.filter((call) => call[2].cursor === "next"),
    ).toHaveLength(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "remote",
      "tools/call",
      { name: "read", arguments: {} },
      30_000,
      {},
    );
  });

  it.each(["repeat", "", 42, "x".repeat(4_001)])(
    "rejects invalid or repeated catalog cursor %s without dispatch",
    async (nextCursor) => {
      mocks.rpc.mockResolvedValue({ tools: [], nextCursor });
      await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
        "MCP_CATALOG_PAGINATION_INVALID",
      );
      await expect(
        callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
      ).rejects.toBeInstanceOf(McpToolNotDispatchedError);
      expect(
        mocks.rpc.mock.calls.every((call) => call[1] === "tools/list"),
      ).toBe(true);
      expect(mocks.rpc.mock.calls.length).toBeLessThanOrEqual(4);
    },
  );

  it("rejects endless unique cursor pages at the page limit without returning a partial catalog", async () => {
    mocks.rpc.mockImplementation(async (_id, _method, params) => ({
      tools: [],
      nextCursor: String(Number(params.cursor ?? 0) + 1),
    }));
    await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
      "MCP_CATALOG_LIMIT_EXCEEDED",
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(10);
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).rejects.toBeInstanceOf(McpToolNotDispatchedError);
    expect(mocks.rpc).toHaveBeenCalledTimes(20);
    expect(mocks.rpc.mock.calls.every((call) => call[1] === "tools/list")).toBe(
      true,
    );
  });

  it("bounds total tools and cumulative response bytes without dispatch", async () => {
    mocks.rpc.mockResolvedValue({
      tools: Array.from({ length: 1_001 }, (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: "object" },
      })),
    });
    await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
      "MCP_CATALOG_LIMIT_EXCEEDED",
    );
    mocks.rpc.mockImplementation(
      async (_id, _method, _params, _timeout, options) => {
        options.onResponseBytes(4_000_001);
        return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
      },
    );
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).rejects.toMatchObject({
      name: "McpToolNotDispatchedError",
      message: "MCP_CATALOG_LIMIT_EXCEEDED",
    });
    expect(mocks.rpc.mock.calls.every((call) => call[1] === "tools/list")).toBe(
      true,
    );
  });

  it("rejects malformed later pages and duplicate names instead of exposing partial tools", async () => {
    mocks.rpc.mockImplementation(async (_id, _method, params) =>
      params.cursor
        ? { tools: null }
        : {
            tools: [{ name: "read", inputSchema: { type: "object" } }],
            nextCursor: "next",
          },
    );
    await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
      "MCP_CATALOG_INVALID",
    );
    mocks.rpc.mockImplementation(async (_id, _method, params) => ({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      ...(params.cursor ? {} : { nextCursor: "next" }),
    }));
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).rejects.toMatchObject({
      name: "McpToolNotDispatchedError",
      message: "MCP_CATALOG_INVALID",
    });
    expect(mocks.rpc.mock.calls.every((call) => call[1] === "tools/list")).toBe(
      true,
    );
  });

  it("resolves the owner-scoped encrypted recipe before discovery", async () => {
    await expect(listPinnedRemoteMcpTools(context())).resolves.toMatchObject([
      { name: "read" },
    ]);
    expect(mocks.operation).toHaveBeenCalledWith(
      "workspace",
      "remote",
      expect.any(Function),
    );
    expect(mocks.deployment).toHaveBeenNthCalledWith(1, {
      where: { id: "remote", workspaceId: "workspace" },
    });
    expect(mocks.deployment).toHaveBeenNthCalledWith(2, {
      where: { id: "remote", workspaceId: "workspace" },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.start).toHaveBeenCalledWith(
      "remote",
      expect.objectContaining({
        headers: { authorization: "Bearer private-token" },
      }),
      { workspaceId: "workspace" },
    );
  });

  it("rejects a credential envelope belonging to another workspace", async () => {
    const deployment = fixture();
    deployment.installCfg = sealMcpEnvironment(
      deployment.installCfg,
      "other-owner",
      { TOKEN: "other-secret" },
    );
    mocks.deployment.mockResolvedValue(deployment);
    await expect(listPinnedRemoteMcpTools(context(deployment))).rejects.toThrow(
      "MCP_CREDENTIAL_SCOPE_INVALID",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a recipe changed between authorization and private resolution", async () => {
    mocks.deployment.mockResolvedValueOnce(fixture()).mockResolvedValue({
      ...fixture(),
      sourceRef: "https://other.example.com/mcp",
    });
    await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
      "MCP_DEFINITION_CHANGED",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not call a tool after credentials rotate during discovery", async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.deployment.mockResolvedValue(fixture("rotated-token"));
      return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
    });
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).rejects.toThrow("MCP_CONNECTION_RESTART_REQUIRED");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "remote",
      "tools/list",
      {},
      5_000,
      expect.objectContaining({
        maxResponseBytes: 4_000_000,
        onResponseBytes: expect.any(Function),
      }),
    );
  });

  it("does not call a tool after credentials are cleared during discovery", async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.deployment.mockResolvedValue(fixture(""));
      return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
    });
    await expect(
      callPinnedRemoteMcpTool(context(), "read", {}, ["read"]),
    ).rejects.toThrow("MCP_CREDENTIAL_REQUIRED");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "remote",
      "tools/list",
      {},
      5_000,
      expect.objectContaining({
        maxResponseBytes: 4_000_000,
        onResponseBytes: expect.any(Function),
      }),
    );
  });

  it("fails closed when the deployment owner operation is unavailable", async () => {
    mocks.operation.mockResolvedValue({ accepted: false });
    await expect(listPinnedRemoteMcpTools(context())).rejects.toThrow(
      "MCP_CONNECTION_UNAVAILABLE",
    );
    expect(mocks.deployment).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

it("redacts resolved credential values from an approved pinned tool result", async () => {
  const beforeCall = vi.fn(async () => {});
  const deployment = {
    ...remote,
    id: "remote",
    workspaceId: "workspace",
    mcpToolExposure: "allowlist",
    mcpAllowedTools: ["read"],
    installCfg: sealMcpEnvironment(
      { ...remote.installCfg, authType: "bearer", bearerEnv: "TOKEN" },
      "workspace",
      { TOKEN: "private-token" },
    ),
  };
  mocks.deployment.mockResolvedValue(deployment);
  mocks.operation.mockImplementation(
    async (_workspaceId, _deploymentId, operation) => ({
      accepted: true,
      value: await operation(),
    }),
  );
  mocks.snapshot.mockReturnValue(undefined);
  mocks.start.mockImplementation(async (_id, spec) => {
    mocks.snapshot.mockReturnValue({
      remoteConnectionIdentity: remoteMcpConnectionIdentity(spec),
    });
  });
  mocks.rpc
    .mockReset()
    .mockResolvedValueOnce({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    })
    .mockResolvedValueOnce({
      content: [{ type: "text", text: "private-token" }],
    });
  const result = await callPinnedRemoteMcpTool(
    {
      workspaceId: "workspace",
      deploymentId: "remote",
      definitionChecksum: mcpDefinitionChecksum(deployment),
    },
    "read",
    {},
    ["read"],
    {},
    beforeCall,
  );
  expect(beforeCall).toHaveBeenCalledOnce();
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "remote",
    "tools/call",
    { name: "read", arguments: {} },
    30_000,
    {},
  );
  expect(JSON.stringify(result)).not.toContain("private-token");
});
