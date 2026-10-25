import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  conversation: vi.fn(),
  context: vi.fn(),
  revision: vi.fn(),
  binding: vi.fn(),
  deployment: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn(),
  rpc: vi.fn(),
  owner: vi.fn(),
  files: vi.fn(),
  image: vi.fn(),
  resolve: vi.fn(),
  identity: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: mocks.agent },
    conversation: { findFirst: mocks.conversation },
    a2AContext: { findFirst: mocks.context },
    agentRevision: { findFirst: mocks.revision },
    agentServer: { findUnique: mocks.binding },
    deployment: { findFirst: mocks.deployment },
    deploymentConfigFile: { findMany: mocks.files },
  },
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: mocks.owner,
  beginRuntimeOperation: () => () => undefined,
}));
vi.mock("@/lib/agents/revision-types", () => ({
  AgentRevisionConfigSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/process/supervisor", () => ({
  startProcess: mocks.start,
  stopProcess: mocks.stop,
  liveRedactionValues: () => [],
  liveMcpRuntimeSnapshot: mocks.snapshot,
  mcpRuntimeCredentialIdentity: mocks.identity,
}));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: mocks.list,
  mcpRpc: mocks.rpc,
}));
vi.mock("@/lib/market/revocation", () => ({
  assertMarketReleasesExecutable: vi.fn(),
}));
vi.mock("@/lib/agents/environment-credentials", () => ({
  assertAgentEnvironmentCredentialReferences: vi.fn(),
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  resolveDockerImageDigest: vi.fn(),
}));
vi.mock("@/lib/process/mcp-runtime-image", () => ({
  prepareSessionMcpRuntimeImage: vi.fn(),
  sessionMcpPackageLaunch: () => ({ args: [] }),
  validateSessionMcpRuntimeImage: mocks.image,
}));
vi.mock("@/lib/process/mcp-credentials", () => ({
  resolveMcpConnectionSpawnSpec: mocks.resolve,
}));

import {
  callSessionMcpTool,
  listSessionMcpTools,
  sessionMcpProcessId,
  sessionMcpRequest,
  stopSessionMcp,
} from "@/lib/process/session-mcp";
import { assertMarketReleasesExecutable } from "@/lib/market/revocation";
import { assertAgentEnvironmentCredentialReferences } from "@/lib/agents/environment-credentials";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesIdentity,
  assertSessionMcpRecipePinned,
} from "@/lib/process/mcp-definition";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { reconcileDeployments } from "@/lib/process/reconcile";

const session = {
  workspaceId: "workspace",
  agentId: "agent",
  agentRevisionId: "revision",
  conversationId: "conversation",
};
const recipe = {
  id: "recipe",
  workspaceId: "workspace",
  serverId: null,
  name: "MCP",
  source: "config",
  sourceRef: null,
  installCfg: { command: "npx", args: ["-y", "example-mcp@1.0.0"], env: {} },
  mcpToolExposure: "all",
  mcpAllowedTools: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue({ id: "agent" });
  mocks.conversation.mockResolvedValue({ id: "conversation" });
  mocks.context.mockResolvedValue({ id: "context" });
  mocks.revision.mockResolvedValue({
    config: {
      packages: [],
      environment: { credentialReferences: [] },
      mcpGrants: [
        {
          deploymentId: "recipe",
          definitionChecksum: mcpDefinitionChecksum(recipe),
          runtimeFilesChecksum: mcpRuntimeFilesIdentity([]),
          runtimeImageDigest: `sha256:${"a".repeat(64)}`,
          allowedToolNames: ["approved"],
        },
      ],
    },
  });
  mocks.binding.mockResolvedValue({
    agentId: "agent",
    deploymentId: "recipe",
    allowedToolNames: ["approved"],
  });
  mocks.deployment.mockResolvedValue(recipe);
  mocks.files.mockResolvedValue([]);
  mocks.image.mockResolvedValue(`sha256:${"a".repeat(64)}`);
  mocks.resolve.mockResolvedValue({
    spec: resolveSpawnSpec(recipe),
    redactionValues: [],
  });
  mocks.identity.mockReturnValue("current-private-mac");
  mocks.snapshot.mockReturnValue({ credentialIdentity: "current-private-mac" });
  mocks.list.mockResolvedValue([
    { name: "approved" },
    { name: "new-unapproved" },
  ]);
});

it("applies live per-Agent narrowing to an already-pinned session", async () => {
  mocks.revision.mockResolvedValue({
    config: {
      packages: [],
      environment: { credentialReferences: [] },
      mcpGrants: [
        {
          deploymentId: "recipe",
          definitionChecksum: mcpDefinitionChecksum(recipe),
          runtimeFilesChecksum: mcpRuntimeFilesIdentity([]),
          runtimeImageDigest: `sha256:${"a".repeat(64)}`,
          allowedToolNames: ["approved", "removed"],
        },
      ],
    },
  });
  await expect(
    callSessionMcpTool(session, "recipe", "removed", {}),
  ).rejects.toThrow("MCP_TOOL_FORBIDDEN");
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("treats an empty live Agent approval as deny-all for old pinned sessions", async () => {
  mocks.binding.mockResolvedValue({
    agentId: "agent",
    deploymentId: "recipe",
    allowedToolNames: [],
  });
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "MCP_TOOL_FORBIDDEN",
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("does not broaden an old pin when live grants include a newly discovered tool", async () => {
  mocks.binding.mockResolvedValue({
    agentId: "agent",
    deploymentId: "recipe",
    allowedToolNames: ["approved", "new-unapproved"],
  });
  await expect(
    callSessionMcpTool(session, "recipe", "new-unapproved", {}),
  ).rejects.toThrow("MCP_TOOL_FORBIDDEN");
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("rejects changed secret configuration bytes before process startup", async () => {
  mocks.files.mockResolvedValue([
    {
      id: "file",
      path: "config.json",
      encryptedContent: { ciphertext: "changed" },
      size: 10,
    },
  ]);
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "MCP_RUNTIME_FILES_CHANGED",
  );
  expect(mocks.start).not.toHaveBeenCalled();
});

it("rejects recipe redirection under an existing pinned grant", async () => {
  mocks.deployment.mockResolvedValue({
    ...recipe,
    installCfg: { ...recipe.installCfg, args: ["-y", "other-server@1.0.0"] },
  });
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "MCP_DEFINITION_CHANGED",
  );
  expect(mocks.start).not.toHaveBeenCalled();
});

it("pins credential key references without serializing their values", () => {
  const first = {
    ...recipe,
    installCfg: { ...recipe.installCfg, env: { API_TOKEN: "secret-one" } },
  };
  const rotated = {
    ...first,
    installCfg: { ...first.installCfg, env: { API_TOKEN: "secret-two" } },
  };
  expect(mcpDefinitionChecksum(first)).toBe(mcpDefinitionChecksum(rotated));
  expect(mcpDefinitionChecksum(first)).not.toBe(mcpDefinitionChecksum(recipe));
});

it("refuses floating package recipes instead of silently selecting latest", () => {
  expect(() =>
    assertSessionMcpRecipePinned({
      ...recipe,
      installCfg: { ...recipe.installCfg, args: ["-y", "example-mcp"] },
    }),
  ).toThrow("MCP_EXACT_PACKAGE_VERSION_REQUIRED");
  expect(() => assertSessionMcpRecipePinned(recipe)).not.toThrow();
  expect(() =>
    assertSessionMcpRecipePinned({
      ...recipe,
      source: "pypi",
      sourceRef: "example>=1",
    }),
  ).toThrow("MCP_EXACT_PACKAGE_VERSION_REQUIRED");
});

it("does not install packages or start a server when its pinned artifact was removed", async () => {
  mocks.image.mockRejectedValueOnce(new Error("MCP_PREPARATION_REQUIRED"));
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "MCP_PREPARATION_REQUIRED",
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("does not turn the composer read API into an unrestricted tool gateway", async () => {
  await expect(
    sessionMcpRequest(session, "recipe", "tools/call", { name: "approved" }),
  ).rejects.toThrow("MCP_METHOD_FORBIDDEN");
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("refuses a revoked pinned release before starting any process", async () => {
  vi.mocked(assertMarketReleasesExecutable).mockRejectedValueOnce(
    new Error("release_revoked"),
  );
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "release_revoked",
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("refuses revoked environment references without decrypting or forwarding secrets", async () => {
  vi.mocked(assertAgentEnvironmentCredentialReferences).mockRejectedValueOnce(
    new Error("credential_revoked"),
  );
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "credential_revoked",
  );
  expect(mocks.start).not.toHaveBeenCalled();
});

describe("session MCP authorization and lifecycle", () => {
  it("never shares the same recipe across sessions, workspaces or revisions", () => {
    const id = sessionMcpProcessId(session, "recipe");
    expect(sessionMcpProcessId({ ...session }, "recipe")).toBe(id);
    expect(
      sessionMcpProcessId({ ...session, conversationId: "other" }, "recipe"),
    ).not.toBe(id);
    expect(
      sessionMcpProcessId({ ...session, workspaceId: "other" }, "recipe"),
    ).not.toBe(id);
    expect(
      sessionMcpProcessId({ ...session, agentRevisionId: "other" }, "recipe"),
    ).not.toBe(id);
    expect(
      sessionMcpProcessId(
        { ...session, conversationId: undefined, a2aContextId: "conversation" },
        "recipe",
      ),
    ).not.toBe(id);
  });

  it("rejects missing or ambiguous session identities", () => {
    expect(() =>
      sessionMcpProcessId({ ...session, conversationId: undefined }, "recipe"),
    ).toThrow("MCP_SESSION_REQUIRED");
    expect(() =>
      sessionMcpProcessId({ ...session, a2aContextId: "context" }, "recipe"),
    ).toThrow("MCP_SESSION_REQUIRED");
  });

  it("rejects stale session ownership before starting anything", async () => {
    mocks.conversation.mockResolvedValue(null);
    await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
      "MCP_SESSION_FORBIDDEN",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects revoked Agent binding rather than reusing a cached runtime", async () => {
    mocks.binding.mockResolvedValue(null);
    await expect(
      callSessionMcpTool(session, "recipe", "approved", {}),
    ).rejects.toThrow("MCP_GRANT_REVOKED");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not auto-grant newly discovered tools", async () => {
    expect(await listSessionMcpTools(session, "recipe")).toEqual([
      { name: "approved" },
    ]);
    await expect(
      callSessionMcpTool(session, "recipe", "new-unapproved", {}),
    ).rejects.toThrow("MCP_TOOL_FORBIDDEN");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("honors live tool revocation even when the revision approved it", async () => {
    mocks.deployment.mockResolvedValue({
      ...recipe,
      mcpToolExposure: "allowlist",
      mcpAllowedTools: [],
    });
    await expect(
      callSessionMcpTool(session, "recipe", "approved", {}),
    ).rejects.toThrow("MCP_TOOL_FORBIDDEN");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rechecks revocation after catalog discovery before a side effect", async () => {
    mocks.binding
      .mockResolvedValueOnce({
        agentId: "agent",
        deploymentId: "recipe",
        allowedToolNames: ["approved"],
      })
      .mockResolvedValue(null);
    await expect(
      callSessionMcpTool(session, "recipe", "approved", {}),
    ).rejects.toThrow("MCP_GRANT_REVOKED");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stops only the owning session sidecar and never removes session files", async () => {
    await stopSessionMcp(session);
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(
      sessionMcpProcessId(session, "recipe"),
    );
    expect(mocks.stop).not.toHaveBeenCalledWith("recipe");
  });
});

it("never falls back to plaintext recipe values when scoped credential resolution fails", async () => {
  mocks.resolve.mockRejectedValueOnce(
    new Error("MCP_CREDENTIAL_OWNER_MISMATCH"),
  );
  await expect(
    callSessionMcpTool(session, "recipe", "approved", {}),
  ).rejects.toThrow("MCP_CREDENTIAL_OWNER_MISMATCH");
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("redacts owner-scoped resolved secrets even when they are absent from metadata env values", async () => {
  mocks.resolve.mockResolvedValue({
    spec: resolveSpawnSpec(recipe),
    redactionValues: ["owner-only-secret"],
  });
  mocks.rpc.mockResolvedValue({
    content: [{ type: "text", text: "owner-only-secret" }],
  });
  const result = await callSessionMcpTool(session, "recipe", "approved", {});
  expect(JSON.stringify(result)).not.toContain("owner-only-secret");
});

it.each(["rotated", "removed-optional-key"])(
  "refuses a surviving stdio process with %s credentials",
  async (change) => {
    mocks.identity.mockReturnValue(`${change}-private-mac`);
    await expect(
      callSessionMcpTool(session, "recipe", "approved", {}),
    ).rejects.toThrow("MCP_CONNECTION_RESTART_REQUIRED");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);

it("rechecks credential identity after discovery immediately before the effect", async () => {
  mocks.identity
    .mockReturnValueOnce("current-private-mac")
    .mockReturnValue("rotated-private-mac");
  await expect(
    callSessionMcpTool(session, "recipe", "approved", {}),
  ).rejects.toThrow("MCP_CONNECTION_RESTART_REQUIRED");
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("does not trust an old runtime entry with no private credential identity", async () => {
  mocks.snapshot.mockReturnValue({});
  await expect(listSessionMcpTools(session, "recipe")).rejects.toThrow(
    "MCP_CONNECTION_RESTART_REQUIRED",
  );
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("never resumes a retained legacy Agent runtime during ordinary MCP recovery", async () => {
  const resolve = vi.fn();
  const started = await reconcileDeployments({
    loadRunning: async () => [
      {
        ...recipe,
        source: "sandbox",
        sandbox: { agentRuntime: { kind: "hermes" } },
      },
    ],
    start: mocks.start,
    resolve,
  });
  expect(started).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("rejects retired Hermes spawn recipes instead of downgrading them to ordinary Docker", () => {
  expect(() =>
    resolveSpawnSpec({
      ...recipe,
      source: "sandbox",
      installCfg: {
        sandboxId: "retained-sandbox",
        kind: "hermes",
        runtimeId: "retained-runtime",
        image: "legacy-runtime",
        env: {},
      },
    }),
  ).toThrow("AGENT_RUNTIME_RETIRED");
});
