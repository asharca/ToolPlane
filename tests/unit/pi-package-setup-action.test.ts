import { beforeEach, expect, it, vi } from "vitest";
import { AgentRevisionError } from "@/lib/agents/revisions";
import {
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";

const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  release: vi.fn(),
  agent: vi.fn(),
  sandbox: vi.fn(),
  deployment: vi.fn(),
  existing: vi.fn(),
  install: vi.fn(),
  installMcp: vi.fn(),
  update: vi.fn(),
  apply: vi.fn(),
  current: vi.fn(),
  prepare: vi.fn(),
  sharing: vi.fn(),
  env: vi.fn(),
  start: vi.fn(),
  config: vi.fn(),
  inspect: vi.fn(),
  manifest: {
    package: {
      toolplane: {
        mcp: [] as Array<{ key: string; name: string; tools: string[] }>,
      },
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: m.sharing,
    marketRelease: { findFirst: m.release },
    agent: { findFirst: m.agent },
    sandbox: { findFirst: m.sandbox },
    deployment: { findFirst: m.deployment },
    marketInstall: { findUnique: m.existing },
  },
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/workspace/actions", () => ({
  setDeploymentEnvAction: m.env,
  startDeploymentAction: m.start,
  updateMcpJsonConfigAction: m.config,
}));
vi.mock("@/lib/workspace/inspector-actions", () => ({
  connectMcpInspectorAction: m.inspect,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/market/resources", () => ({
  installPiPackageRelease: m.install,
  installMarketRelease: m.installMcp,
  updateMarketInstall: m.update,
}));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/market/pi-package-manifest", () => ({
  parsePiPackageReleaseManifest: () => m.manifest,
  scanPiPackageReleaseManifest: () => ({ status: "clean" }),
}));
vi.mock("@/lib/agents/mutations", () => ({
  AgentConfigurationError: class extends Error {},
}));
vi.mock("@/lib/agents/revisions", () => ({
  pinCurrentAgentRevision: m.current,
  AgentRevisionError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));
vi.mock("@/lib/market/pi-package-agent-apply", () => ({
  applyPiPackageToAgent: m.apply,
}));
vi.mock("@/lib/process/mcp-definition", () => ({
  prepareSessionMcpDefinition: m.prepare,
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  withAgentMaintenanceLease: (_id: string, run: () => Promise<unknown>) =>
    run(),
  AgentExecutionBusyError: class extends Error {},
}));

import { configurePiPackageAction } from "@/lib/market/pi-package-setup-action";
import { AgentExecutionBusyError } from "@/lib/agents/agent-execution-gate";
import { AgentConfigurationError } from "@/lib/agents/mutations";

function form(agentId = "") {
  const input = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "workspace",
    releaseId: "release",
    idempotencyKey: "wizard-key",
    confirmExecutableCode: "yes",
    agentId,
    expectedRevisionId: "applied-revision",
    confirmApplyToAgent: "yes",
  }))
    input.set(key, value);
  return input;
}
function withMcp() {
  m.manifest.package.toolplane.mcp = [
    { key: "search", name: "Search", tools: ["lookup"] },
  ];
  const input = form("selected-agent");
  input.set("confirmExpandedPrivileges", "yes");
  input.set(
    "mcps",
    JSON.stringify([
      {
        key: "search",
        deploymentId: "mcp",
      },
    ]),
  );
  return input;
}
beforeEach(() => {
  vi.clearAllMocks();
  m.manifest.package.toolplane.mcp = [];
  m.user.mockResolvedValue({ id: "user" });
  m.workspace.mockResolvedValue({ id: "workspace-id" });
  m.release.mockResolvedValue({
    id: "release",
    listingId: "listing",
    manifest: {},
    checksum: "fixture",
  });
  m.agent.mockResolvedValue({
    id: "selected-agent",
    sandboxes: [{ sandboxId: "sandbox" }],
    currentRevisionVersion: 1,
    piPackages: [
      { marketInstallId: "another-package", releaseId: "untouched" },
    ],
  });
  m.sandbox.mockResolvedValue({ id: "sandbox" });
  m.deployment.mockResolvedValue({
    id: "mcp",
    status: "stopped",
    source: "config",
    installCfg: sealMcpEnvironment({}, "workspace-id", {
      TOKEN: "private-credential",
    }),
    server: null,
  });
  m.start.mockImplementation(async () => {
    const deployment = await m.deployment();
    m.deployment.mockResolvedValue({ ...deployment, status: "running" });
  });
  m.env.mockImplementation(async (input: FormData) => {
    const patch = JSON.parse(String(input.get("changes"))) as {
      set: Record<string, string>;
      remove: string[];
    };
    const deployment = await m.deployment();
    const environment = {
      ...resolveMcpEnvironment(deployment.installCfg, "workspace-id"),
      ...patch.set,
    };
    for (const name of patch.remove) delete environment[name];
    m.deployment.mockResolvedValue({
      ...deployment,
      installCfg: sealMcpEnvironment(
        deployment.installCfg,
        "workspace-id",
        environment,
      ),
    });
    return { savedAt: 1 };
  });
  m.existing.mockResolvedValue(null);
  m.install.mockResolvedValue({ install: { id: "install" } });
  m.config.mockResolvedValue({ savedAt: 1 });
  m.inspect.mockResolvedValue({ tools: [{ name: "lookup" }] });
  m.apply.mockResolvedValue({ id: "published-revision" });
  m.current.mockResolvedValue({
    id: "applied-revision",
    config: { sandboxTemplateId: "sandbox" },
  });
  m.prepare.mockResolvedValue({
    definitionChecksum: "prepared",
    runtimeImageDigest: null,
  });
  m.sharing.mockResolvedValue([{ shared: false }]);
});

it("requires executable-code and expanded-privilege consent before side effects", async () => {
  const input = form();
  input.delete("confirmExecutableCode");
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    error: "pi_package_executable_confirmation_required",
    enabled: false,
  });
  const mcp = withMcp();
  mcp.delete("confirmExpandedPrivileges");
  expect(await configurePiPackageAction({}, mcp)).toMatchObject({
    error: "pi_package_privileges_confirmation_required",
    enabled: false,
  });
  expect(m.install).not.toHaveBeenCalled();
  expect(m.env).not.toHaveBeenCalled();
  expect(m.apply).not.toHaveBeenCalled();
});
it("keeps workspace installation separate from Agent defaults", async () => {
  expect(await configurePiPackageAction({}, form())).toMatchObject({
    status: "complete",
    marketInstallId: "install",
    enabled: false,
  });
  expect(m.apply).not.toHaveBeenCalled();
});
it("reports the selected Agent's applied revision only after publication succeeds", async () => {
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    status: "complete",
    agentId: "selected-agent",
    enabled: true,
    agentRevisionId: "published-revision",
  });
});
it("reports a real installed package but not enabled success when the selected Agent is busy", async () => {
  m.apply.mockRejectedValueOnce(new AgentExecutionBusyError());
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    status: "partial",
    step: "agent",
    marketInstallId: "install",
    enabled: false,
    error: "pi_package_agent_busy",
  });
});
it("preserves partial state when existing Work prevents applying the reviewed package", async () => {
  m.apply.mockRejectedValueOnce(
    new AgentConfigurationError("pi_package_agent_busy"),
  );
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    status: "partial",
    step: "agent",
    enabled: false,
    error: "pi_package_agent_busy",
  });
});
it("rejects unavailable approval or Agent scope before configuring MCP", async () => {
  m.release.mockResolvedValueOnce(null);
  expect(await configurePiPackageAction({}, withMcp())).toMatchObject({
    error: "listing_unavailable",
  });
  m.agent.mockResolvedValueOnce(null);
  expect(await configurePiPackageAction({}, withMcp())).toMatchObject({
    error: "agent_not_found",
  });
  expect(m.env).not.toHaveBeenCalled();
  expect(m.install).not.toHaveBeenCalled();
});
it("starts and tests the selected MCP before applying the reviewed Agent revision", async () => {
  const result = await configurePiPackageAction({}, withMcp());
  expect(result).toMatchObject({
    status: "complete",
    deployments: [{ key: "search", deploymentId: "mcp", status: "tested" }],
    enabled: true,
    agentRevisionId: "published-revision",
  });
  expect(m.start.mock.invocationCallOrder[0]).toBeLessThan(
    m.inspect.mock.invocationCallOrder[0],
  );
  expect(m.inspect.mock.invocationCallOrder[0]).toBeLessThan(
    m.install.mock.invocationCallOrder[0],
  );
  expect(m.install.mock.invocationCallOrder[0]).toBeLessThan(
    m.apply.mock.invocationCallOrder[0],
  );
  expect(JSON.stringify(result)).not.toContain("private-credential");
});
it("reports truthful partial MCP failure without installing or enabling code", async () => {
  m.inspect.mockResolvedValueOnce({ error: "authenticationFailed" });
  const result = await configurePiPackageAction({}, withMcp());
  expect(result).toMatchObject({
    status: "partial",
    step: "mcp",
    error: "authenticationFailed",
    enabled: false,
    deployments: [{ deploymentId: "mcp", status: "running" }],
  });
  expect(m.install).not.toHaveBeenCalled();
  expect(m.apply).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-credential");
});
it("never treats a direct inspector success as managed deployment readiness after startup failed", async () => {
  m.start.mockResolvedValueOnce(undefined);
  expect(await configurePiPackageAction({}, withMcp())).toMatchObject({
    status: "partial",
    step: "mcp",
    error: "connectorFailed",
    enabled: false,
    deployments: [{ deploymentId: "mcp", status: "configured" }],
  });
  expect(m.inspect).not.toHaveBeenCalled();
  expect(m.install).not.toHaveBeenCalled();
  expect(m.apply).not.toHaveBeenCalled();
});
it("atomically submits explicitly confirmed expanded bindings with the approved target version", async () => {
  m.existing.mockResolvedValueOnce({
    id: "install",
    status: "ready",
    currentReleaseId: "old-release",
  });
  expect(await configurePiPackageAction({}, withMcp())).toMatchObject({
    status: "complete",
    enabled: true,
    agentRevisionId: "published-revision",
  });
  expect(m.update).toHaveBeenCalledWith({
    installId: "install",
    targetWorkspaceId: "workspace-id",
    actorId: "user",
    targetReleaseId: "release",
    currentReleaseId: "old-release",
    mcpBindings: { search: { deploymentId: "mcp", tools: ["lookup"] } },
  });
  expect(m.install).not.toHaveBeenCalled();
});

it("installs a selected market MCP through its existing installer before connecting", async () => {
  const input = withMcp();
  input.set(
    "mcps",
    JSON.stringify([{ key: "search", releaseId: "mcp-release" }]),
  );
  m.release
    .mockResolvedValueOnce({
      id: "release",
      listingId: "listing",
      manifest: {},
      checksum: "fixture",
    })
    .mockResolvedValueOnce({ id: "mcp-release" });
  m.installMcp.mockResolvedValueOnce({ kind: "mcp", resource: { id: "mcp" } });
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    status: "complete",
    deployments: [{ deploymentId: "mcp", status: "tested" }],
  });
  expect(m.installMcp).toHaveBeenCalledWith({
    releaseId: "mcp-release",
    targetWorkspaceId: "workspace-id",
    installedById: "user",
    idempotencyKey: "wizard-key:mcp:search",
  });
});
it("never mutates a selected existing shared connection during package installation", async () => {
  const input = withMcp();
  input.set(
    "mcps",
    JSON.stringify([
      {
        key: "search",
        deploymentId: "mcp",
        changes: { set: { TOKEN: "private" }, remove: [] },
      },
    ]),
  );
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    error: "shared_connection_configuration_required",
    enabled: false,
  });
  expect(m.env).not.toHaveBeenCalled();
  expect(m.config).not.toHaveBeenCalled();
  expect(m.start).not.toHaveBeenCalled();
});
it("surfaces fresh-connection environment impact refusals before starting or installing code", async () => {
  const input = withMcp();
  input.set(
    "mcps",
    JSON.stringify([
      {
        key: "search",
        releaseId: "mcp-release",
        changes: { set: { TOKEN: "private" }, remove: [] },
      },
    ]),
  );
  m.installMcp.mockResolvedValueOnce({
    kind: "mcp",
    resource: { id: "mcp" },
    reused: false,
    install: {
      installedById: "user",
      targetWorkspaceId: "workspace-id",
      idempotencyKey: "wizard-key:mcp:search",
      requestedReleaseId: "mcp-release",
      currentReleaseId: "mcp-release",
    },
  });
  m.env.mockResolvedValueOnce({
    error: "sharedChangeConfirmationRequired",
    impactedObjects: { agentIds: ["other"], assistantIds: [] },
  });
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    status: "partial",
    error: "sharedChangeConfirmationRequired",
    enabled: false,
  });
  expect(m.start).not.toHaveBeenCalled();
  expect(m.install).not.toHaveBeenCalled();
});

it("requires a published baseline and explicit Apply consent before installation side effects", async () => {
  m.agent.mockResolvedValueOnce({
    id: "selected-agent",
    currentRevisionVersion: 0,
    sandboxes: [],
  });
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    error: "agent_revision_preparation_required",
    enabled: false,
  });
  const unconfirmed = form("selected-agent");
  unconfirmed.delete("confirmApplyToAgent");
  expect(await configurePiPackageAction({}, unconfirmed)).toMatchObject({
    error: "agent_revision_apply_confirmation_required",
    enabled: false,
  });
  m.current.mockResolvedValueOnce({
    id: "concurrently-applied",
    config: { sandboxTemplateId: "sandbox" },
  });
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    error: "agent_revision_conflict",
    enabled: false,
  });
  expect(m.install).not.toHaveBeenCalled();
  expect(m.installMcp).not.toHaveBeenCalled();
  expect(m.apply).not.toHaveBeenCalled();
});

it("reports a retained workspace install but never enabled success when final revision CAS fails", async () => {
  m.apply.mockRejectedValueOnce(
    new AgentRevisionError("AGENT_REVISION_CONFLICT"),
  );
  expect(
    await configurePiPackageAction({}, form("selected-agent")),
  ).toMatchObject({
    status: "partial",
    step: "agent",
    marketInstallId: "install",
    enabled: false,
    error: "agent_revision_conflict",
  });
});

it("allows corrected credentials on the same operation's unshared idempotently reused MCP", async () => {
  const input = withMcp();
  const choice = {
    key: "search",
    releaseId: "mcp-release",
    changes: { set: { TOKEN: "private-credential" }, remove: [] },
  };
  input.set("mcps", JSON.stringify([choice]));
  m.release.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      listingId: "listing",
      manifest: {},
      checksum: "fixture",
    }),
  );
  m.installMcp.mockResolvedValue({
    kind: "mcp",
    resource: { id: "mcp" },
    reused: true,
    install: {
      installedById: "user",
      targetWorkspaceId: "workspace-id",
      idempotencyKey: "wizard-key:mcp:search",
      requestedReleaseId: "mcp-release",
      currentReleaseId: "mcp-release",
    },
  });
  m.inspect.mockResolvedValueOnce({ error: "authenticationFailed" });
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    status: "partial",
    step: "mcp",
    error: "authenticationFailed",
    enabled: false,
  });
  expect(
    resolveMcpEnvironment((await m.deployment()).installCfg, "workspace-id")
      .TOKEN,
  ).toBe("private-credential");
  input.set(
    "mcps",
    JSON.stringify([
      {
        ...choice,
        changes: { set: { TOKEN: "corrected-secret" }, remove: [] },
      },
    ]),
  );
  const completed = await configurePiPackageAction({}, input);
  expect(completed).toMatchObject({
    status: "complete",
    enabled: true,
    agentRevisionId: "published-revision",
  });
  expect(JSON.stringify(completed)).not.toContain("corrected-secret");
  const stored = (await m.deployment()).installCfg;
  expect(stored.env).toEqual({ TOKEN: "" });
  expect(resolveMcpEnvironment(stored, "workspace-id").TOKEN).toBe(
    "corrected-secret",
  );
  expect(() => resolveMcpEnvironment(stored, "another-workspace")).toThrow(
    "MCP_CREDENTIAL_SCOPE_INVALID",
  );
});

it.each([
  "different-owner",
  "different-operation",
  "changed-release",
  "shared",
])("refuses to configure an idempotent MCP when it is %s", async (reason) => {
  const input = withMcp();
  input.set(
    "mcps",
    JSON.stringify([
      {
        key: "search",
        releaseId: "mcp-release",
        changes: { set: { TOKEN: "private-credential" }, remove: [] },
      },
    ]),
  );
  m.installMcp.mockResolvedValue({
    kind: "mcp",
    resource: { id: "mcp" },
    reused: true,
    install: {
      installedById: reason === "different-owner" ? "other" : "user",
      targetWorkspaceId: "workspace-id",
      idempotencyKey:
        reason === "different-operation"
          ? "other-operation"
          : "wizard-key:mcp:search",
      requestedReleaseId: "mcp-release",
      currentReleaseId:
        reason === "changed-release" ? "other-release" : "mcp-release",
    },
  });
  m.sharing.mockResolvedValue([{ shared: reason === "shared" }]);
  expect(await configurePiPackageAction({}, input)).toMatchObject({
    status: "partial",
    error: "shared_connection_configuration_required",
    enabled: false,
    deployments: [{ deploymentId: "mcp", status: "installed" }],
  });
  expect(m.env).not.toHaveBeenCalled();
  expect(m.config).not.toHaveBeenCalled();
  expect(m.start).not.toHaveBeenCalled();
});
