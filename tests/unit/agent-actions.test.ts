import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SandboxRuntime from "@/lib/agents/sandbox-runtime";
import type * as AgentQueries from "@/lib/agents/queries";
import { AgentConfigurationError } from "@/lib/agents/mutations";

const mocks = vi.hoisted(() => ({
  systemLog: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  createConfiguredAgent: vi.fn(),
  setAgentTools: vi.fn(),
  updateAgent: vi.fn(),
  updateProvider: vi.fn(),
  agentFindFirst: vi.fn(),
  agentUpdateMany: vi.fn(),
  createConversation: vi.fn(),
  renameConsoleConversation: vi.fn(),
  generateConsoleConversationTitle: vi.fn(),
  deleteConsoleConversation: vi.fn(),
  updateAgentModelSelection: vi.fn(),
  agentFindMany: vi.fn(),
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
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  createAgentChannelConnection: vi.fn(),
  deleteAgentChannelConnection: vi.fn(),
  updateAgentChannelConnectionCredentials: vi.fn(),
}));
vi.mock("@/lib/agents/channel-pairing", () => ({
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
vi.mock("@/lib/agents/deletion", () => ({
  deleteManagedAgent: mocks.deleteManagedAgent,
}));

import {
  createAgentAction,
  deleteAgentAction,
  pinAgentAction,
  installAgentFromMarketAction,
  updateAgentAction,
  updateAgentModelAction,
  updateProviderAction,
  updateWorkspaceModelPreferenceAction,
  updateAgentRuntimeEnvAction,
  checkPiRuntimesAction,
  updatePiRuntimesAction,
  createConversationAction,
  generateConversationTitleAction,
  renameConversationAction,
  deleteConversationAction,
  publishAgentReleaseAction,
  unpublishAgentListingAction,
  withdrawPendingAgentReleaseAction,
} from "@/lib/agents/actions";

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
    runtimeKind: "pi",
    sandboxes: [{ sandboxId: "sandbox-1" }],
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

describe("agent runtime environment action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
  });

  it("delegates a dedicated runtime environment change to its assigned sandbox", async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
      })
      .mockResolvedValueOnce({
        sandboxes: [{ sandboxId: "sandbox-1" }],
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
      { runtime: "pi" },
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

describe("deleteAgentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.deleteManagedAgent.mockResolvedValue(true);
  });

  it("deletes an agent from the unified sandbox view and returns there", async () => {
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
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
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

describe("conversation title generation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
  });

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
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it.each([
    updateAgentAction,
    updateAgentModelAction,
    updateAgentRuntimeEnvAction,
  ])(
    "rejects missing manageable agents before runtime mutations",
    async (action) => {
      mocks.agentFindFirst.mockResolvedValue(null);
      await expect(action({}, runtimeForm())).resolves.toEqual({
        error: "Agent not found.",
      });
      expect(mocks.updateAgent).not.toHaveBeenCalled();
    },
  );

  it.each([
    deleteAgentAction,
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

  it("does not report a missing runtime sandbox as successfully saved", async () => {
    const form = runtimeForm();
    form.set("runtimeEnv", "CUSTOM=value");
    mocks.agentFindFirst.mockResolvedValue({
      publicRuntimeAllocation: null,
      sandboxes: [],
    });
    await expect(updateAgentRuntimeEnvAction({}, form)).resolves.toEqual({
      error: "Agent runtime sandbox not found.",
    });
    expect(mocks.updateSandboxEnvAction).not.toHaveBeenCalled();
  });

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
    expect(mocks.updateSandboxEnvAction).not.toHaveBeenCalled();
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
});
