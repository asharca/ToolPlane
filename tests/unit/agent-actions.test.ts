import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SandboxRuntime from "@/lib/agents/sandbox-runtime";
import type * as AgentQueries from "@/lib/agents/queries";
import { AgentConfigurationError } from "@/lib/agents/mutations";

const mocks = vi.hoisted(() => ({
  systemLog: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
  createConfiguredAgent: vi.fn(),
  cloneAgent: vi.fn(),
  cloneHermesVolumeData: vi.fn(),
  copyHermesRuntimeVolume: vi.fn(),
  setAgentTools: vi.fn(),
  setHermesRuntimeEnv: vi.fn(),
  stopHermesRuntime: vi.fn(),
  syncHermesRuntime: vi.fn(),
  runHermesRuntimeMaintenance: vi.fn(),
  requestHermesRuntimeSync: vi.fn(),
  updateAgent: vi.fn(),
  updateProvider: vi.fn(),
  upgradeHermesRuntime: vi.fn(),
  agentFindFirst: vi.fn(),
  agentUpdateMany: vi.fn(),
  createConversation: vi.fn(),
  renameConsoleConversation: vi.fn(),
  generateConsoleConversationTitle: vi.fn(),
  deleteConsoleConversation: vi.fn(),
  updateAgentModelSelection: vi.fn(),
  bindHermesAgentModelProvider: vi.fn(),
  setHermesConversationSelection: vi.fn(),
  agentFindMany: vi.fn(),
  listHermesProfiles: vi.fn(),
  listHermesProfileModels: vi.fn(),
  supportsHermesProfileChat: vi.fn(),
  ensureHermesProfileProjection: vi.fn(),
  getProvider: vi.fn(),
  workspaceUpdate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  startProcess: vi.fn(),
  updateSandboxEnvAction: vi.fn(),
  materializeAgentRelease: vi.fn(),
  deleteManagedAgent: vi.fn(),
  redirect: vi.fn(),
  getPiRuntimeVersion: vi.fn(),
  updatePiRuntimeVersion: vi.fn(),
  publishAgentRelease: vi.fn(),
  unpublishAgentListing: vi.fn(),
  withdrawPendingAgentRelease: vi.fn(),
  setHermesProfileDefaultModel: vi.fn(),
}));

vi.mock("@/lib/observability/system", () => ({ systemLog: mocks.systemLog }));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/agents/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentQueries>()),
  getProvider: mocks.getProvider,
}));
vi.mock("@/lib/agents/conversation-naming", () => ({
  generateConsoleConversationTitle: mocks.generateConsoleConversationTitle,
}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: {
      findFirst: mocks.agentFindFirst,
      findMany: mocks.agentFindMany,
      updateMany: mocks.agentUpdateMany,
    },
    deployment: { updateMany: mocks.deploymentUpdateMany },
    workspace: { update: mocks.workspaceUpdate },
  },
}));
vi.mock("@/lib/process/spawn-spec", () => ({
  resolveSpawnSpec: mocks.resolveSpawnSpec,
}));
vi.mock("@/lib/process/supervisor", () => ({
  startProcess: mocks.startProcess,
}));
vi.mock("@/lib/sandboxes/actions", () => ({
  updateSandboxEnvAction: mocks.updateSandboxEnvAction,
}));
vi.mock("@/lib/agents/sandbox-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SandboxRuntime>()),
  getPiRuntimeVersion: mocks.getPiRuntimeVersion,
  updatePiRuntimeVersion: mocks.updatePiRuntimeVersion,
}));
vi.mock("@/lib/agents/mutations", () => ({
  cloneAgent: mocks.cloneAgent,
  cloneHermesVolumeData: mocks.cloneHermesVolumeData,
  createConfiguredAgent: mocks.createConfiguredAgent,
  AgentConfigurationError: class AgentConfigurationError extends Error {},
  updateAgent: mocks.updateAgent,
  setAgentTools: mocks.setAgentTools,
  deleteAgent: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: mocks.updateProvider,
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  createConversation: mocks.createConversation,
  renameConsoleConversation: mocks.renameConsoleConversation,
  deleteConsoleConversation: mocks.deleteConsoleConversation,
  updateAgentModelSelection: mocks.updateAgentModelSelection,
  bindHermesAgentModelProvider: mocks.bindHermesAgentModelProvider,
  setHermesConversationSelection: mocks.setHermesConversationSelection,
  setHermesRuntimeEnv: mocks.setHermesRuntimeEnv,
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  createAgentChannelConnection: vi.fn(),
  deleteAgentChannelConnection: vi.fn(),
  updateAgentChannelConnectionCredentials: vi.fn(),
}));
vi.mock("@/lib/agents/channel-pairing", () => ({
  applyAgentChannelPairing: vi.fn(),
  checkAgentChannelPairing: vi.fn(),
  requestAgentChannelPairing: vi.fn(),
}));
vi.mock("@/lib/agents/market", () => ({
  AgentMarketError: class AgentMarketError extends Error {
    code = "install_failed";
  },
  materializeAgentRelease: mocks.materializeAgentRelease,
  publishAgentRelease: mocks.publishAgentRelease,
  unpublishAgentListing: mocks.unpublishAgentListing,
  withdrawPendingAgentRelease: mocks.withdrawPendingAgentRelease,
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  cleanupHermesRuntime: vi.fn(),
  copyHermesRuntimeVolume: mocks.copyHermesRuntimeVolume,
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
  runHermesRuntimeMaintenance: mocks.runHermesRuntimeMaintenance,
  stopHermesRuntime: mocks.stopHermesRuntime,
  syncHermesRuntime: mocks.syncHermesRuntime,
  upgradeHermesRuntime: mocks.upgradeHermesRuntime,
}));
vi.mock("@/lib/agents/deletion", () => ({
  deleteManagedAgent: mocks.deleteManagedAgent,
}));
vi.mock("@/lib/agents/hermes/profiles", () => ({
  ensureHermesProfileProjection: mocks.ensureHermesProfileProjection,
  hasHermesProfileModel: (
    options: { providers: Array<{ id: string; models: string[] }> },
    provider: string,
    model: string,
  ) =>
    options.providers.some(
      (item) => item.id === provider && item.models.includes(model),
    ),
  HermesProfileError: class HermesProfileError extends Error {},
  listHermesProfileModels: mocks.listHermesProfileModels,
  listHermesProfiles: mocks.listHermesProfiles,
  normalizeHermesProfile: (value: unknown) => {
    const profile = String(value ?? "")
      .trim()
      .toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? profile : null;
  },
  setHermesProfileDefaultModel: mocks.setHermesProfileDefaultModel,
  supportsHermesProfileChat: mocks.supportsHermesProfileChat,
}));

import {
  stopAgentRuntimeAction,
  syncAgentRuntimeAction,
  createAgentAction,
  cloneAgentAction,
  deleteAgentAction,
  pinAgentAction,
  installAgentFromMarketAction,
  updateAgentAction,
  updateAgentModelAction,
  updateHermesConversationSelectionAction,
  updateProviderAction,
  updateWorkspaceModelPreferenceAction,
  updateAgentRuntimeEnvAction,
  updateHermesRuntimeEnvAction,
  upgradeHermesRuntimeAction,
  checkPiRuntimesAction,
  updatePiRuntimesAction,
  createConversationAction,
  generateConversationTitleAction,
  renameConversationAction,
  deleteConversationAction,
  publishAgentReleaseAction,
  unpublishAgentListingAction,
  withdrawPendingAgentReleaseAction,
  updateHermesProfileDefaultModelAction,
} from "@/lib/agents/actions";

function upgradeForm(image = "nousresearch/hermes-agent:v2026.8.3") {
  const form = new FormData();
  form.set("workspace", "acme");
  form.set("agentId", "agent-1");
  form.set("hermesImage", image);
  return form;
}

function runtimeForm() {
  const form = new FormData();
  form.set("workspace", "acme");
  form.set("agentId", "agent-1");
  return form;
}

function mockAuthorizedAgent() {
  mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
  mocks.getWorkspaceForUser.mockResolvedValue({
    id: "workspace-1",
    ownerId: "user-1",
  });
  mocks.agentFindFirst.mockResolvedValue({
    publicRuntimeAllocation: null,
    runtimeKind: "hermes",
    sandboxes: [],
    runtime: {
      sandboxId: "sandbox-1",
      sandbox: { config: { managedBy: "agent-runtime" } },
    },
  });
}

function createdRuntimeAgent(runtimeKind = "pi", withSandbox = true) {
  return {
    runtimeKind,
    sandboxes: withSandbox
      ? [
          {
            sandbox: {
              deployment: {
                id: "sandbox-deployment-1",
                serverId: null,
                name: "Sandbox: Harness Workspace",
                source: "sandbox",
                sourceRef: "toolplane/sandbox:latest",
                installCfg: {},
              },
            },
          },
        ]
      : [],
  };
}

describe("upgradeHermesRuntimeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.upgradeHermesRuntime.mockResolvedValue({ status: "provisioning" });
  });

  it("authorizes through the workspace and forwards a trimmed image choice", async () => {
    const result = await upgradeHermesRuntimeAction(
      {},
      upgradeForm("  nousresearch/hermes-agent:v2026.8.3  "),
    );

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith("acme", "user-1");
    expect(mocks.upgradeHermesRuntime).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "nousresearch/hermes-agent:v2026.8.3",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/agents");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/app/acme/agents/agent-1",
    );
  });

  it("does not contact Docker through the runtime without workspace access", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue(null);

    await expect(
      upgradeHermesRuntimeAction({}, upgradeForm()),
    ).resolves.toEqual({
      error: "Not authorized.",
    });
    expect(mocks.upgradeHermesRuntime).not.toHaveBeenCalled();
  });

  it("returns the runtime pull or rebuild failure to the settings form", async () => {
    mocks.upgradeHermesRuntime.mockResolvedValue({
      status: "error",
      error: "Could not pull Hermes image: manifest unknown",
    });

    await expect(
      upgradeHermesRuntimeAction({}, upgradeForm()),
    ).resolves.toEqual({
      error: "Could not pull Hermes image: manifest unknown",
    });
  });
});

describe("workspace Pi version management actions", () => {
  const agentIds = ["agent-1", "agent-2", "agent-3"];
  let pins: Record<string, string>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    pins = { "agent-1": "0.80.3", "agent-2": "0.80.3", "agent-3": "0.80.3" };
    mocks.agentFindMany.mockReset().mockResolvedValue([
      { id: "agent-1", name: "First" },
      { id: "agent-2", name: "Second" },
      { id: "agent-3", name: "Third" },
    ]);
    mocks.getPiRuntimeVersion
      .mockReset()
      .mockImplementation(async (_workspace: string, id: string) => ({
        version: pins[id],
        installed: true,
      }));
    mocks.updatePiRuntimeVersion
      .mockReset()
      .mockImplementation(
        async (_workspace: string, id: string, version: string) => {
          pins[id] = version;
          return { version, installed: true };
        },
      );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.agentFindMany.mockReset();
  });

  it("rejects unauthenticated and cross-workspace requests before enumerating or changing runtimes", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect((await checkPiRuntimesAction("acme")).error).toBe("Not authorized.");
    mockAuthorizedAgent();
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    expect(
      (await updatePiRuntimesAction("foreign-workspace", "latest", agentIds))
        .error,
    ).toBe("Not authorized.");
    expect(mocks.agentFindMany).not.toHaveBeenCalled();
    expect(mocks.getPiRuntimeVersion).not.toHaveBeenCalled();
    expect(mocks.updatePiRuntimeVersion).not.toHaveBeenCalled();
  });

  it("rejects unsafe package specifiers and rechecks public allocation visibility before updates", async () => {
    expect(
      (await updatePiRuntimesAction("acme", "file:/tmp/package", agentIds))
        .error,
    ).toMatch(/exact Pi version/);
    mocks.agentFindFirst.mockResolvedValue({
      publicRuntimeAllocation: { id: "public" },
    });
    const result = await updatePiRuntimesAction("acme", "0.87.1", agentIds);
    expect(result.agents?.map((agent) => agent.status)).toEqual([
      "error",
      "error",
      "error",
    ]);
    expect(Object.values(pins)).toEqual(["0.80.3", "0.80.3", "0.80.3"]);
    expect(mocks.updatePiRuntimeVersion).not.toHaveBeenCalled();
  });

  it("keeps the full version inventory visible on registry failure without choosing an unknown release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const checked = await checkPiRuntimesAction("acme");
    expect(checked.warning).toBeTruthy();
    expect(
      checked.agents?.map((agent) => [
        agent.agentId,
        agent.version,
        agent.status,
      ]),
    ).toEqual([
      ["agent-1", "0.80.3", "ready"],
      ["agent-2", "0.80.3", "ready"],
      ["agent-3", "0.80.3", "ready"],
    ]);
    expect(
      (await updatePiRuntimesAction("acme", "latest", agentIds)).error,
    ).toBeTruthy();
    expect(Object.values(pins)).toEqual(["0.80.3", "0.80.3", "0.80.3"]);
  });

  it("resolves latest once and upgrades every agent to the same exact version", async () => {
    const registry = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ version: "0.87.1" }))
      .mockResolvedValue(Response.json({ version: "0.88.0" }));
    vi.stubGlobal("fetch", registry);
    const result = await updatePiRuntimesAction("acme", "latest", agentIds);
    expect(result.targetVersion).toBe("0.87.1");
    expect(result.agents?.map((agent) => agent.status)).toEqual([
      "updated",
      "updated",
      "updated",
    ]);
    expect(Object.values(pins)).toEqual(["0.87.1", "0.87.1", "0.87.1"]);
    expect(registry).toHaveBeenCalledTimes(1);
  });

  it("skips current agents, preserves failed agents, and continues updating later agents", async () => {
    pins["agent-1"] = "0.87.1";
    mocks.updatePiRuntimeVersion.mockRejectedValueOnce(
      new Error("package failed to launch"),
    );
    const result = await updatePiRuntimesAction("acme", "0.87.1", agentIds);
    expect(
      result.agents?.map((agent) => [
        agent.agentId,
        agent.version,
        agent.status,
      ]),
    ).toEqual([
      ["agent-1", "0.87.1", "unchanged"],
      ["agent-2", "0.80.3", "error"],
      ["agent-3", "0.87.1", "updated"],
    ]);
    expect(Object.values(pins)).toEqual(["0.87.1", "0.80.3", "0.87.1"]);
    expect(result.finishedAt).toEqual(expect.any(Number));
  });

  it("reports busy or unavailable runtimes without hiding them or stopping the batch", async () => {
    mocks.getPiRuntimeVersion.mockRejectedValueOnce(
      new Error("sandbox unavailable"),
    );
    const result = await updatePiRuntimesAction("acme", "0.87.1", agentIds);
    expect(result.agents?.map((agent) => agent.status)).toEqual([
      "error",
      "updated",
      "updated",
    ]);
    expect(pins).toEqual({
      "agent-1": "0.80.3",
      "agent-2": "0.87.1",
      "agent-3": "0.87.1",
    });
  });

  it("updates only selected agents once and leaves every unselected pin untouched", async () => {
    const result = await updatePiRuntimesAction("acme", "0.87.1", [
      "agent-2",
      "agent-2",
    ]);
    expect(
      result.agents?.map((agent) => [
        agent.agentId,
        agent.version,
        agent.status,
      ]),
    ).toEqual([["agent-2", "0.87.1", "updated"]]);
    expect(pins).toEqual({
      "agent-1": "0.80.3",
      "agent-2": "0.87.1",
      "agent-3": "0.80.3",
    });
    expect(mocks.getPiRuntimeVersion).toHaveBeenCalledTimes(1);
    expect(mocks.updatePiRuntimeVersion).toHaveBeenCalledTimes(1);
  });

  it.each(
    [[], undefined, null, "agent-1", [null], [" "]].map((selection) => ({
      selection,
    })),
  )(
    "rejects an empty or malformed selection: $selection",
    async ({ selection }) => {
      const result = await updatePiRuntimesAction(
        "acme",
        "latest",
        selection as unknown as string[],
      );
      expect(result.error).toBeTruthy();
      expect(pins).toEqual({
        "agent-1": "0.80.3",
        "agent-2": "0.80.3",
        "agent-3": "0.80.3",
      });
      expect(mocks.getPiRuntimeVersion).not.toHaveBeenCalled();
      expect(mocks.updatePiRuntimeVersion).not.toHaveBeenCalled();
    },
  );

  it("rejects a mixed valid and unavailable selection before changing any agent", async () => {
    const result = await updatePiRuntimesAction("acme", "0.87.1", [
      "agent-1",
      "outside-authorized-collection",
    ]);
    expect(result.error).toMatch(/unavailable in this workspace/);
    expect(pins).toEqual({
      "agent-1": "0.80.3",
      "agent-2": "0.80.3",
      "agent-3": "0.80.3",
    });
    expect(mocks.getPiRuntimeVersion).not.toHaveBeenCalled();
    expect(mocks.updatePiRuntimeVersion).not.toHaveBeenCalled();
  });

  it("continues within the selected subset after failure without updating unselected agents", async () => {
    mocks.updatePiRuntimeVersion.mockRejectedValueOnce(
      new Error("package failed to launch"),
    );
    const result = await updatePiRuntimesAction("acme", "0.87.1", [
      "agent-1",
      "agent-3",
    ]);
    expect(
      result.agents?.map((agent) => [agent.agentId, agent.status]),
    ).toEqual([
      ["agent-1", "error"],
      ["agent-3", "updated"],
    ]);
    expect(pins).toEqual({
      "agent-1": "0.80.3",
      "agent-2": "0.80.3",
      "agent-3": "0.87.1",
    });
  });
});

describe("Hermes runtime control actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
    mocks.setHermesRuntimeEnv.mockResolvedValue(true);
    mocks.syncHermesRuntime.mockResolvedValue({ status: "stopped" });
  });

  it("forces an explicit sync and waits for a provisioning runtime to become healthy", async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: "provisioning" });

    const result = await syncAgentRuntimeAction({}, runtimeForm());

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      { force: true },
    );
    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
    );
  });

  it("reports a failed health check instead of claiming a provisioning sync succeeded", async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: "provisioning" });
    mocks.ensureHermesRuntimeReady.mockResolvedValueOnce({
      error: "Hermes gateway did not become healthy within 45 seconds.",
    });

    await expect(syncAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: "Hermes gateway did not become healthy within 45 seconds.",
    });
  });

  it("keeps agent autosave hash-based and forces an explicit environment sync", async () => {
    const agentForm = runtimeForm();
    agentForm.set("name", "Hermes");
    await expect(updateAgentAction({}, agentForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.syncHermesRuntime).toHaveBeenLastCalledWith(
      "workspace-1",
      "agent-1",
    );

    mocks.syncHermesRuntime.mockClear();
    const envForm = runtimeForm();
    envForm.set("hermesEnv", "CHANNEL_TOKEN=value");
    await expect(updateHermesRuntimeEnvAction({}, envForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.syncHermesRuntime).toHaveBeenLastCalledWith(
      "workspace-1",
      "agent-1",
      { force: true },
    );
  });

  it("waits for a forced environment restart to become healthy", async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: "provisioning" });
    const envForm = runtimeForm();
    envForm.set("hermesEnv", "CUSTOM_SETTING=value");

    await expect(updateHermesRuntimeEnvAction({}, envForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });

    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      { force: true },
    );
    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
    );
  });

  it("delegates a dedicated runtime environment change to its assigned sandbox", async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
        runtime: { sandbox: { config: { managedBy: "agent-runtime" } } },
      })
      .mockResolvedValueOnce({
        runtimeKind: "pi",
        sandboxes: [{ sandboxId: "sandbox-1" }],
        runtime: null,
      });
    const envForm = runtimeForm();
    envForm.set("runtimeEnv", "CUSTOM_SETTING=value");

    await expect(updateAgentRuntimeEnvAction({}, envForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    const sandboxForm = mocks.updateSandboxEnvAction.mock.calls.at(
      -1,
    )?.[0] as FormData;
    expect(sandboxForm.get("workspace")).toBe("acme");
    expect(sandboxForm.get("sandboxId")).toBe("sandbox-1");
    expect(sandboxForm.get("env")).toBe("CUSTOM_SETTING=value");
  });

  it("returns the strict stop failure to the caller", async () => {
    mocks.stopHermesRuntime.mockRejectedValueOnce(
      new Error("Could not stop the Hermes runtime: Docker daemon unavailable"),
    );

    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: "Could not stop the Hermes runtime: Docker daemon unavailable",
    });
  });
});

describe("createAgentAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "user-1",
    });
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      models: ["model-1"],
    });
    mocks.createConfiguredAgent.mockResolvedValue({ id: "agent-1" });
    mocks.agentFindFirst.mockResolvedValue(createdRuntimeAgent());
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: "sandbox" });
    mocks.syncHermesRuntime.mockResolvedValue({ status: "provisioning" });
  });

  it("starts the automatically provisioned sandbox for a newly created Pi agent", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Harness");
    form.set("runtime", "pi");
    form.set("providerId", "provider-1");
    form.set("model", "model-1");

    await createAgentAction(form);

    expect(mocks.createConfiguredAgent).toHaveBeenCalledWith(
      "workspace-1",
      {
        name: "Harness",
        description: null,
        systemPrompt: null,
        providerId: "provider-1",
        providerIds: ["provider-1"],
        model: "model-1",
        disabledBuiltinTools: [],
        maxSteps: 100,
      },
      {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [],
      },
      { runtime: "pi", hermesImage: "" },
    );
    expect(mocks.agentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "agent-1", workspaceId: "workspace-1" },
      }),
    );
    expect(mocks.startProcess).toHaveBeenCalledWith(
      "sandbox-deployment-1",
      { kind: "sandbox" },
      { awaitReady: false, workspaceId: "workspace-1" },
    );
    expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app/acme/work?agent=agent-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it.each(["claude-code", "dsh", "hermes-rpc", "hermes", "toolloop"])(
    "rejects new %s agents before provisioning",
    async (runtime) => {
      const form = new FormData();
      form.set("workspace", "acme");
      form.set("name", "Harness");
      form.set("runtime", runtime);
      form.set("providerId", "provider-1");
      form.set("model", "model-1");

      await expect(createAgentAction(form)).rejects.toThrow();

      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
      expect(mocks.startProcess).not.toHaveBeenCalled();
      expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );

  it("propagates Pi provisioning failure without starting or opening an agent", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("runtime", "pi");
    form.set("providerId", "provider-1");
    form.set("model", "model-1");
    mocks.createConfiguredAgent.mockRejectedValueOnce(
      new Error("Sandbox provisioning failed"),
    );

    await expect(createAgentAction(form)).rejects.toThrow(
      "Sandbox provisioning failed",
    );

    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(["signed out", "outside workspace"])(
    "does not provision when %s",
    async (access) => {
      const form = new FormData();
      form.set("workspace", "acme");
      form.set("runtime", "pi");
      form.set("providerId", "provider-1");
      form.set("model", "model-1");
      if (access === "signed out")
        mocks.getCurrentUser.mockResolvedValueOnce(null);
      else mocks.getWorkspaceForUser.mockResolvedValueOnce(null);

      await createAgentAction(form);

      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
      expect(mocks.startProcess).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );

  it("does not create an agent without a runnable model configuration", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Harness");
    form.set("runtime", "pi");

    await expect(createAgentAction(form)).rejects.toThrow(
      "Choose an available model.",
    );
    expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
  });

  it("does not create an agent with a model outside the selected provider", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Harness");
    form.set("runtime", "pi");
    form.set("providerId", "provider-1");
    form.set("model", "stale-model");

    await expect(createAgentAction(form)).rejects.toThrow(
      "Choose an available model.",
    );
    expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
  });

  it("keeps the created agent and marks its sandbox errored when startup fails", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Harness");
    form.set("runtime", "pi");
    form.set("providerId", "provider-1");
    form.set("model", "model-1");
    mocks.startProcess.mockRejectedValueOnce(new Error("Docker unavailable"));

    await expect(createAgentAction(form)).resolves.toBeUndefined();

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "sandbox-deployment-1", workspaceId: "workspace-1" },
      data: { status: "error" },
    });
    expect(mocks.redirect).toHaveBeenCalledWith("/app/acme/work?agent=agent-1");
    expect(mocks.systemLog).toHaveBeenCalledWith(
      "error",
      "Failed to start runtime sandbox for Agent agent-1.",
      expect.objectContaining({ message: "Docker unavailable" }),
    );
  });

  it("keeps the created agent when its runtime sandbox cannot be loaded", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Harness");
    form.set("runtime", "pi");
    form.set("providerId", "provider-1");
    form.set("model", "model-1");
    mocks.agentFindFirst.mockResolvedValueOnce(
      createdRuntimeAgent("pi", false),
    );

    await expect(createAgentAction(form)).resolves.toBeUndefined();

    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app/acme/work?agent=agent-1");
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.systemLog).toHaveBeenCalledWith(
      "error",
      "Failed to start runtime sandbox for Agent agent-1.",
      expect.objectContaining({
        message: "The Agent runtime sandbox was not created.",
      }),
    );
  });

  it.each([undefined, "unknown"])(
    "rejects a missing or unavailable runtime (%s)",
    async (runtime) => {
      const form = new FormData();
      form.set("workspace", "acme");
      form.set("name", "Harness");
      if (runtime) form.set("runtime", runtime);

      await expect(createAgentAction(form)).rejects.toThrow();
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
    },
  );
});

describe("installAgentFromMarketAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "user-1",
    });
    mocks.materializeAgentRelease.mockResolvedValue({
      agent: { id: "agent-1" },
    });
    mocks.agentFindFirst.mockResolvedValue(createdRuntimeAgent());
    mocks.resolveSpawnSpec.mockReturnValue({ kind: "sandbox" });
  });

  it("starts a native Agent installed from the create form market branch", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("releaseId", "release-1");
    form.set("idempotencyKey", "request-1");

    await installAgentFromMarketAction(form);

    expect(mocks.startProcess).toHaveBeenCalledWith(
      "sandbox-deployment-1",
      { kind: "sandbox" },
      { awaitReady: false, workspaceId: "workspace-1" },
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/app/acme/work?agent=agent-1");
  });
});

describe("cloneAgentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "user-1",
    });
    mocks.agentFindFirst.mockResolvedValue(
      createdRuntimeAgent("hermes", false),
    );
    mocks.cloneAgent.mockResolvedValue({
      id: "agent-copy",
      runtimeKind: "hermes",
    });
    mocks.syncHermesRuntime.mockResolvedValue({ status: "provisioning" });
  });

  it("starts a cloned Agent and opens it in Work", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("agentId", "agent-1");

    await cloneAgentAction(form);

    expect(mocks.cloneAgent).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      undefined,
      undefined,
    );
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith(
      "workspace-1",
      "agent-copy",
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/app/acme/work?agent=agent-copy",
    );
  });
});

describe("deleteAgentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.deleteManagedAgent.mockResolvedValue(true);
  });

  it("deletes a Hermes agent from the unified sandbox view and returns there", async () => {
    const form = runtimeForm();
    form.set("returnTo", "/app/acme/sandboxes");

    await deleteAgentAction(form);

    expect(mocks.deleteManagedAgent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      actorId: "user-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/agents");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/sandboxes");
    expect(mocks.redirect).toHaveBeenCalledWith("/app/acme/sandboxes");
  });
});

describe("pinAgentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.agentUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("updates only the authorized workspace Agent and refreshes both surfaces", async () => {
    const form = runtimeForm();
    form.set("pinned", "true");

    await pinAgentAction(form);

    expect(mocks.agentUpdateMany).toHaveBeenCalledWith({
      where: { id: "agent-1", workspaceId: "workspace-1" },
      data: { pinned: true },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/agents");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("does not update an Agent without an authorized workspace", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const form = runtimeForm();
    form.set("pinned", "false");

    await pinAgentAction(form);

    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("model configuration action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.syncHermesRuntime.mockResolvedValue({ status: "stopped" });
  });

  it("updates only the selected model binding and refreshes the chat workspace", async () => {
    mocks.updateAgentModelSelection.mockResolvedValueOnce("native");
    const form = runtimeForm();
    form.set("providerId", "provider-1");
    form.set("model", "gpt-5");

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
    });

    expect(mocks.updateAgentModelSelection).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      ["provider-1"],
      "gpt-5",
    );
    expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("reports a saved model selection as a warning when Hermes projection fails", async () => {
    mocks.updateAgentModelSelection.mockResolvedValueOnce("hermes");
    mocks.syncHermesRuntime.mockResolvedValueOnce({
      status: "error",
      error: "projection failed",
    });
    const form = runtimeForm();
    form.set("providerId", "provider-1");
    form.set("model", "gpt-5");

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({
      warning: "Saved, but Hermes sync failed: projection failed",
      savedAt: expect.any(Number),
    });
  });
});

describe("Hermes profile and provider actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "user-1",
    });
    mocks.supportsHermesProfileChat.mockResolvedValue(true);
    mocks.ensureHermesProfileProjection.mockResolvedValue(undefined);
    mocks.bindHermesAgentModelProvider.mockResolvedValue(
      "toolplane-provider-1",
    );
    mocks.syncHermesRuntime.mockResolvedValue({ status: "running" });
    mocks.listHermesProfileModels.mockResolvedValue({
      profile: "default",
      provider: "toolplane-provider-1",
      model: "model-a",
      providers: [
        { id: "toolplane-provider-1", name: "Provider", models: ["model-a"] },
      ],
    });
    mocks.listHermesProfiles.mockResolvedValue([
      {
        name: "default",
        isDefault: true,
        provider: "openrouter",
        model: "model-a",
        description: "",
      },
    ]);
    mocks.setHermesConversationSelection.mockResolvedValue({
      conversationId: "conversation-1",
      created: false,
    });
    mocks.runHermesRuntimeMaintenance.mockImplementation(
      async (...args: unknown[]) => ({
        status: "completed",
        data: await (
          args[4] as (context: { requestSync: () => void }) => Promise<unknown>
        )({
          requestSync: mocks.requestHermesRuntimeSync,
        }),
      }),
    );
  });

  it("changes a conversation profile only inside the runtime write barrier", async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
        runtime: { sandbox: { config: { managedBy: "agent-runtime" } } },
      })
      .mockResolvedValueOnce({
        id: "agent-1",
        workspaceId: "workspace-1",
        runtime: { id: "runtime-1", kind: "hermes", sandboxId: "sandbox-1" },
      });
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    form.set("profile", "default");
    form.set("useDefault", "1");

    await expect(
      updateHermesConversationSelectionAction({}, form),
    ).resolves.toEqual({
      savedAt: expect.any(Number),
      conversationId: "conversation-1",
      created: false,
    });
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "sandbox-1",
      { quiesce: false },
      expect.any(Function),
    );
    expect(mocks.setHermesConversationSelection).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
      { profile: "default", provider: null, model: null },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("binds and projects a ToolPlane provider before saving a conversation model", async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
        runtime: { sandbox: { config: { managedBy: "agent-runtime" } } },
      })
      .mockResolvedValueOnce({
        id: "agent-1",
        workspaceId: "workspace-1",
        runtime: { id: "runtime-1", kind: "hermes", sandboxId: "sandbox-1" },
      });
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    form.set("profile", "default");
    form.set("provider", "toolplane-provider-1");
    form.set("model", "model-a");

    await expect(
      updateHermesConversationSelectionAction({}, form),
    ).resolves.toEqual({
      savedAt: expect.any(Number),
      conversationId: "conversation-1",
      created: false,
    });
    expect(mocks.bindHermesAgentModelProvider).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "toolplane-provider-1",
      "model-a",
    );
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      "agent-1",
      "sandbox-1",
      { quiesce: false },
      expect.any(Function),
    );
    expect(mocks.requestHermesRuntimeSync).toHaveBeenCalledOnce();
    expect(mocks.setHermesConversationSelection).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
      {
        profile: "default",
        provider: "toolplane-provider-1",
        model: "model-a",
      },
    );
  });

  it("keeps a provider save successful when runtime reprojection fails", async () => {
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      name: "Provider",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
    });
    mocks.agentFindMany.mockResolvedValue([
      {
        id: "hermes-1",
        runtime: { sandboxId: "sandbox-1" },
      },
    ]);
    mocks.runHermesRuntimeMaintenance.mockResolvedValueOnce({
      status: "error",
      error: "projection failed",
    });
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("providerId", "provider-1");
    form.set("name", "Provider");
    form.set("format", "openai");
    form.set("baseUrl", "https://provider.test/v1");

    await expect(updateProviderAction({}, form)).resolves.toEqual({
      warning: "Hermes sync failed: projection failed",
      savedAt: expect.any(Number),
    });
    expect(mocks.updateProvider).toHaveBeenCalled();
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledWith(
      "workspace-1",
      "hermes-1",
      "sandbox-1",
      { quiesce: false, reprojectAfter: true },
      expect.any(Function),
    );
  });

  it("attempts every Hermes reprojection after an earlier Agent fails", async () => {
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      name: "Provider",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
    });
    mocks.agentFindMany.mockResolvedValue([
      { id: "hermes-1", runtime: { sandboxId: "sandbox-1" } },
      { id: "hermes-2", runtime: { sandboxId: "sandbox-2" } },
    ]);
    mocks.runHermesRuntimeMaintenance
      .mockResolvedValueOnce({ status: "error", error: "first failed" })
      .mockResolvedValueOnce({ status: "completed" });
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("providerId", "provider-1");
    form.set("name", "Provider");
    form.set("format", "openai");
    form.set("baseUrl", "https://provider.test/v1");

    await expect(updateProviderAction({}, form)).resolves.toEqual({
      warning: "Hermes sync failed: first failed",
      savedAt: expect.any(Number),
    });
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledTimes(2);
  });
});

describe("workspace model preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "user-1",
    });
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      models: ["gpt-5"],
    });
  });

  it("rejects members changing workspace defaults or provider credentials", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "someone-else",
    });
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("preference", "default");
    form.set("providerId", "provider-1");
    form.set("name", "Provider");
    form.set("baseUrl", "https://provider.test/v1");
    expect(await updateWorkspaceModelPreferenceAction({}, form)).toEqual({
      error: "Not authorized.",
    });
    expect(await updateProviderAction({}, form)).toEqual({
      error: "Not authorized.",
    });
    expect(mocks.workspaceUpdate).not.toHaveBeenCalled();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it("saves only a model exposed by a provider in the current workspace", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("preference", "title");
    form.set("providerId", "provider-1");
    form.set("model", "gpt-5");

    await expect(
      updateWorkspaceModelPreferenceAction({}, form),
    ).resolves.toEqual({ savedAt: expect.any(Number) });
    expect(mocks.getProvider).toHaveBeenCalledWith("workspace-1", "provider-1");
    expect(mocks.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "workspace-1" },
      data: { titleModelProviderId: "provider-1", titleModel: "gpt-5" },
    });
  });

  it("rejects a stale model and can clear the default selection", async () => {
    mocks.getProvider.mockResolvedValueOnce({
      id: "provider-1",
      models: ["gpt-4.1"],
    });
    const invalid = new FormData();
    invalid.set("workspace", "acme");
    invalid.set("preference", "default");
    invalid.set("providerId", "provider-1");
    invalid.set("model", "gpt-5");
    await expect(
      updateWorkspaceModelPreferenceAction({}, invalid),
    ).resolves.toEqual({
      error: "Choose an available model.",
    });
    expect(mocks.workspaceUpdate).not.toHaveBeenCalled();

    const clear = new FormData();
    clear.set("workspace", "acme");
    clear.set("preference", "default");
    await updateWorkspaceModelPreferenceAction({}, clear);
    expect(mocks.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "workspace-1" },
      data: { defaultModelProviderId: null, defaultModel: null },
    });
  });
});

describe("conversation management actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.renameConsoleConversation.mockResolvedValue(true);
    mocks.generateConsoleConversationTitle.mockResolvedValue("Project brief");
    mocks.deleteConsoleConversation.mockResolvedValue(true);
  });

  it("renames only a workspace-owned console conversation", async () => {
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    form.set("title", "  Project brief  ");

    await renameConversationAction(form);

    expect(mocks.renameConsoleConversation).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
      "Project brief",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("generates a title through the workspace-scoped conversation helper", async () => {
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    form.set("force", "1");

    await expect(generateConversationTitleAction(form)).resolves.toEqual({
      savedAt: expect.any(Number),
    });

    expect(mocks.generateConsoleConversationTitle).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
      true,
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("returns to the agent chat root after deleting a conversation", async () => {
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });

    await expect(deleteConversationAction(form)).rejects.toThrow(
      "redirect:/app/acme/work?agent=agent-1",
    );

    expect(mocks.deleteConsoleConversation).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });
});

describe("createConversationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.createConversation.mockResolvedValue({ id: "conversation-1" });
  });

  it("redirects a newly created conversation to the standalone chat workspace", async () => {
    const form = runtimeForm();
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });

    await expect(createConversationAction(form)).rejects.toThrow(
      "redirect:/app/acme/work?agent=agent-1&c=conversation-1",
    );

    expect(mocks.createConversation).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });
});

describe("agent publishing authorization and form boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.publishAgentRelease.mockReset().mockResolvedValue(undefined);
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it.each([
    ["member", "owner_only"],
    ["unconfirmed", "confirm_required"],
    ["unnamed", "missing_fields"],
  ])(
    "rejects %s publication without exporting agent contents",
    async (condition, error) => {
      const form = runtimeForm();
      form.set("confirmPublicContents", "yes");
      form.set("name", "Agent");
      form.set("summary", "Description");
      if (condition === "member")
        mocks.getWorkspaceForUser.mockResolvedValue({
          id: "workspace-1",
          ownerId: "other",
        });
      if (condition === "unconfirmed") form.delete("confirmPublicContents");
      if (condition === "unnamed") form.set("name", "  ");
      await expect(publishAgentReleaseAction(form)).rejects.toThrow(
        `redirect:/app/acme/agents/agent-1/publish?error=${error}`,
      );
      expect(mocks.publishAgentRelease).not.toHaveBeenCalled();
    },
  );

  it("normalizes public listing fields and de-duplicates bounded tags", async () => {
    const form = runtimeForm();
    form.set("confirmPublicContents", "yes");
    form.set("name", `  ${"n".repeat(90)}  `);
    form.set("summary", `  ${"s".repeat(370)}  `);
    form.set(
      "tags",
      " alpha,alpha, , beta, gamma, delta, epsilon, zeta, seventh",
    );
    form.append("categoryIds", "category-1");
    form.append("categoryIds", "");
    await expect(publishAgentReleaseAction(form)).rejects.toThrow(
      "?submitted=1",
    );
    expect(mocks.publishAgentRelease).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      publishedById: "user-1",
      listing: {
        slug: undefined,
        name: "n".repeat(80),
        summary: "s".repeat(360),
        iconUrl: null,
        tags: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
        categoryIds: ["category-1"],
      },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/app/acme/market/agents",
    );
  });

  it("returns an installation error redirect when publishing fails", async () => {
    const form = runtimeForm();
    form.set("confirmPublicContents", "yes");
    form.set("name", "Agent");
    form.set("summary", "Description");
    mocks.publishAgentRelease.mockRejectedValue(new Error("storage failed"));
    await expect(publishAgentReleaseAction(form)).rejects.toThrow(
      "?error=install_failed",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [unpublishAgentListingAction, "unpublished", "unpublishAgentListing"],
    [
      withdrawPendingAgentReleaseAction,
      "withdrawn",
      "withdrawPendingAgentRelease",
    ],
  ] as const)(
    "performs owner-only listing transition %s",
    async (action, result, operation) => {
      mocks.getWorkspaceForUser.mockResolvedValue({
        id: "workspace-1",
        ownerId: "other",
      });
      await action(runtimeForm());
      expect(mocks[operation]).not.toHaveBeenCalled();
      mockAuthorizedAgent();
      await expect(action(runtimeForm())).rejects.toThrow(`?${result}=1`);
      expect(mocks[operation]).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        actorId: "user-1",
      });
    },
  );

  it("never publishes an endpoint-owned runtime", async () => {
    mocks.agentFindFirst.mockResolvedValue({
      publicRuntimeAllocation: { id: "allocation" },
    });
    await publishAgentReleaseAction(runtimeForm());
    expect(mocks.publishAgentRelease).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("agent package selection validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.updateAgent.mockReset().mockResolvedValue(undefined);
    mocks.syncHermesRuntime.mockResolvedValue({ status: "ready" });
  });

  it.each([
    "not JSON",
    "x".repeat(16001),
    JSON.stringify([
      { marketInstallId: "install", releaseId: "release", extra: "forbidden" },
    ]),
    JSON.stringify([
      { marketInstallId: "install", releaseId: "one" },
      { marketInstallId: "install", releaseId: "two" },
    ]),
    JSON.stringify(
      Array.from({ length: 17 }, (_, index) => ({
        marketInstallId: `install-${index}`,
        releaseId: "release",
      })),
    ),
  ])(
    "rejects invalid package selection without changing agent tools",
    async (selection) => {
      const form = runtimeForm();
      form.set("piPackages", selection);
      await expect(updateAgentAction({}, form)).resolves.toEqual({
        error: "pi_packages_invalid",
      });
      expect(mocks.updateAgent).not.toHaveBeenCalled();
      expect(mocks.setAgentTools).not.toHaveBeenCalled();
    },
  );

  it("saves an explicit empty package set rather than retaining installed packages", async () => {
    const form = runtimeForm();
    form.set("piPackages", "[]");
    await expect(updateAgentAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.updateAgent).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      expect.objectContaining({ piPackages: [] }),
    );
  });

  it.each([
    [
      "Unknown or inaccessible market install: hidden",
      "pi_package_unavailable",
    ],
    ["Duplicate marketInstallId: repeated", "pi_packages_invalid"],
    ["Specific validation failure", "Specific validation failure"],
  ])(
    "maps package mutation failure %s to a safe form result",
    async (message, error) => {
      mocks.updateAgent.mockRejectedValue(new AgentConfigurationError(message));
      await expect(updateAgentAction({}, runtimeForm())).resolves.toEqual({
        error,
      });
      expect(mocks.setAgentTools).not.toHaveBeenCalled();
    },
  );
});

describe("Hermes profile default selection boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.listHermesProfiles
      .mockReset()
      .mockResolvedValue([{ name: "research" }]);
  });

  it("requires a complete valid profile/model pair before accessing the workspace", async () => {
    await expect(
      updateHermesProfileDefaultModelAction({}, runtimeForm()),
    ).resolves.toEqual({ error: "Choose a valid Hermes profile and model." });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.setHermesProfileDefaultModel).not.toHaveBeenCalled();
  });

  it.each([
    "unauthorized",
    "missing-agent",
    "missing-profile",
    "profile-query-failed",
  ])(
    "rejects %s profile change without changing runtime defaults",
    async (condition) => {
      const form = runtimeForm();
      form.set("profile", "research");
      form.set("provider", "provider-1");
      form.set("model", "model-1");
      let error = "Could not update the Hermes profile model.";
      if (condition === "unauthorized") {
        mocks.getCurrentUser.mockResolvedValue(null);
        error = "Not authorized.";
      } else if (condition === "missing-agent") {
        mocks.agentFindFirst.mockResolvedValue(null);
        error = "Hermes agent not found.";
      } else if (condition === "missing-profile") {
        mocks.listHermesProfiles.mockResolvedValue([]);
        error = "The selected Hermes profile no longer exists.";
      } else {
        mocks.listHermesProfiles.mockRejectedValue(
          new Error("transport failed"),
        );
      }
      await expect(
        updateHermesProfileDefaultModelAction({}, form),
      ).resolves.toEqual({ error });
      expect(mocks.setHermesProfileDefaultModel).not.toHaveBeenCalled();
    },
  );

  it("returns a useful error when forced title generation produces no title", async () => {
    const form = runtimeForm();
    form.set("conversationId", "conversation-1");
    form.set("force", "1");
    mocks.generateConsoleConversationTitle.mockResolvedValue(null);
    await expect(generateConversationTitleAction(form)).resolves.toEqual({
      error: "Could not generate a title for this conversation.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([new Error("Provider unavailable"), "non-error failure"])(
    "handles title generation rejection %s",
    async (failure) => {
      const form = runtimeForm();
      form.set("conversationId", "conversation-1");
      mocks.generateConsoleConversationTitle.mockRejectedValue(failure);
      await expect(generateConversationTitleAction(form)).resolves.toEqual({
        error:
          failure instanceof Error
            ? failure.message
            : "Could not generate a conversation title.",
      });
    },
  );
});

describe("round two agent action safety boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.syncHermesRuntime.mockResolvedValue({ status: "ready" });
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it.each([
    updateAgentAction,
    updateAgentModelAction,
    updateAgentRuntimeEnvAction,
    stopAgentRuntimeAction,
    syncAgentRuntimeAction,
    upgradeHermesRuntimeAction,
  ])(
    "rejects missing manageable agents before runtime mutations",
    async (action) => {
      mocks.agentFindFirst.mockResolvedValue(null);
      await expect(action({}, runtimeForm())).resolves.toEqual({
        error: "Agent not found.",
      });
      expect(mocks.updateAgent).not.toHaveBeenCalled();
      expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
      expect(mocks.stopHermesRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    deleteAgentAction,
    cloneAgentAction,
    createConversationAction,
    deleteConversationAction,
    renameConversationAction,
  ])(
    "does not change an inaccessible agent through form actions",
    async (action) => {
      const form = runtimeForm();
      form.set("conversationId", "conversation");
      form.set("title", "Title");
      mocks.agentFindFirst.mockResolvedValue({
        publicRuntimeAllocation: { id: "allocation" },
      });
      await action(form);
      expect(mocks.deleteManagedAgent).not.toHaveBeenCalled();
      expect(mocks.cloneAgent).not.toHaveBeenCalled();
      expect(mocks.createConversation).not.toHaveBeenCalled();
      expect(mocks.renameConsoleConversation).not.toHaveBeenCalled();
      expect(mocks.deleteConsoleConversation).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );

  it.each([
    updateAgentAction,
    updateAgentModelAction,
    updateAgentRuntimeEnvAction,
    stopAgentRuntimeAction,
    syncAgentRuntimeAction,
    upgradeHermesRuntimeAction,
  ])(
    "rejects signed-out form mutations without querying agent data",
    async (action) => {
      mocks.getCurrentUser.mockResolvedValue(null);
      await expect(action({}, runtimeForm())).resolves.toEqual({
        error: "Not authorized.",
      });
      expect(mocks.agentFindFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["deleted", "create-race", "rename-race", "delete-race"])(
    "does not redirect or invalidate on failed persistence: %s",
    async (condition) => {
      const form = runtimeForm();
      form.set("conversationId", "conversation");
      form.set("title", "Title");
      if (condition === "deleted") await deleteAgentAction(form);
      if (condition === "create-race") await createConversationAction(form);
      if (condition === "rename-race") await renameConversationAction(form);
      if (condition === "delete-race") await deleteConversationAction(form);
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("returns model domain errors while preserving unexpected failures for the error boundary", async () => {
    mocks.updateAgentModelSelection.mockRejectedValueOnce(
      new AgentConfigurationError("Unavailable model"),
    );
    await expect(updateAgentModelAction({}, runtimeForm())).resolves.toEqual({
      error: "Unavailable model",
    });
    mocks.updateAgentModelSelection.mockRejectedValueOnce(
      new Error("storage lost"),
    );
    await expect(updateAgentModelAction({}, runtimeForm())).rejects.toThrow(
      "storage lost",
    );
    mocks.updateAgent.mockRejectedValueOnce(new Error("storage lost"));
    await expect(updateAgentAction({}, runtimeForm())).rejects.toThrow(
      "storage lost",
    );
  });

  it("keeps saved agent changes when runtime projection fails", async () => {
    mocks.syncHermesRuntime.mockResolvedValue({ error: "not healthy" });
    await expect(updateAgentAction({}, runtimeForm())).resolves.toEqual({
      savedAt: expect.any(Number),
      warning: "Saved, but Hermes sync failed: not healthy",
    });
    expect(mocks.setAgentTools).toHaveBeenCalledOnce();
  });

  it("does not report a missing runtime environment projection as successfully saved", async () => {
    const form = runtimeForm();
    form.set("runtimeEnv", "CUSTOM=value");
    mocks.setHermesRuntimeEnv.mockResolvedValue(false);
    await expect(updateAgentRuntimeEnvAction({}, form)).resolves.toEqual({
      error: "Hermes runtime not found.",
    });
    expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
  });

  it.each(["sync", "readiness"])(
    "reports saved environment with a %s failure",
    async (failure) => {
      mocks.setHermesRuntimeEnv.mockResolvedValue(true);
      if (failure === "sync")
        mocks.syncHermesRuntime.mockResolvedValue({ error: "runtime failed" });
      else {
        mocks.syncHermesRuntime.mockResolvedValue({ status: "provisioning" });
        mocks.ensureHermesRuntimeReady.mockResolvedValue({
          error: "runtime failed",
        });
      }
      await expect(
        updateAgentRuntimeEnvAction({}, runtimeForm()),
      ).resolves.toEqual({
        error: "Saved, but Hermes sync failed: runtime failed",
      });
    },
  );

  it.each([new Error("cannot write"), "untyped failure"])(
    "reports dedicated sandbox environment write failure %s",
    async (error) => {
      mocks.agentFindFirst.mockResolvedValue({
        publicRuntimeAllocation: null,
        runtimeKind: "pi",
        sandboxes: [{ sandboxId: "sandbox" }],
      });
      mocks.updateSandboxEnvAction.mockRejectedValue(error);
      await expect(
        updateAgentRuntimeEnvAction({}, runtimeForm()),
      ).resolves.toEqual({
        error:
          error instanceof Error
            ? error.message
            : "Could not save environment variables.",
      });
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid environment syntax rather than replacing valid stored variables", async () => {
    const form = runtimeForm();
    form.set("runtimeEnv", "not a variable");
    expect(await updateAgentRuntimeEnvAction({}, form)).toHaveProperty("error");
    expect(mocks.setHermesRuntimeEnv).not.toHaveBeenCalled();
    expect(mocks.updateSandboxEnvAction).not.toHaveBeenCalled();
  });

  it("returns a saved timestamp when stopping succeeds and a safe fallback for unknown stop errors", async () => {
    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    mocks.stopHermesRuntime.mockRejectedValue("unknown");
    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: "Could not stop the Hermes runtime.",
    });
  });

  it.each([
    "/app/acme/market/agents",
    "/app/acme/market/agents?tab=all",
    "https://attacker.test/path",
  ])(
    "keeps installation errors on a safe return path: %s",
    async (returnTo) => {
      const form = runtimeForm();
      form.set("releaseId", "release");
      form.set("idempotencyKey", "key");
      form.set("returnTo", returnTo);
      mocks.materializeAgentRelease.mockRejectedValue(
        new Error("private database detail"),
      );
      const safePath = returnTo.startsWith("/")
        ? returnTo
        : "/app/acme/market/agents";
      await expect(installAgentFromMarketAction(form)).rejects.toThrow(
        `redirect:${safePath}${safePath.includes("?") ? "&" : "?"}cloneError=install_failed`,
      );
      expect(mocks.startProcess).not.toHaveBeenCalled();
    },
  );

  it("does not start a clone when the source disappears during cloning", async () => {
    mocks.cloneAgent.mockResolvedValue(null);
    await cloneAgentAction(runtimeForm());
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("honors scoped-clone options and opens settings instead of starting after a failed volume copy", async () => {
    const form = runtimeForm();
    form.set("cloneOptions", "1");
    form.set("copyMcp", "on");
    form.set("copyHermesVolume", "on");
    form.set("cloneName", " Named clone ");
    mocks.cloneAgent.mockResolvedValue({ id: "cloned", runtimeKind: "hermes" });
    mocks.copyHermesRuntimeVolume.mockImplementation(
      async (_workspace, _source, _target, copy) => {
        await copy();
        return { status: "error" };
      },
    );
    await expect(cloneAgentAction(form)).rejects.toThrow(
      "redirect:/app/acme/agents/cloned?settings=agent",
    );
    expect(mocks.cloneAgent).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "Named clone",
      {
        copyMcp: true,
        copySkills: false,
        copyToolkits: false,
        copySandboxes: false,
        copySubAgents: false,
        copyConversations: false,
        copyHermesEnvironment: false,
        copyHermesVolume: true,
      },
    );
    expect(mocks.cloneHermesVolumeData).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "cloned",
    );
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
});
