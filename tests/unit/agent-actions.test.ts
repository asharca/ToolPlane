import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentQueries from "@/lib/agents/queries";
import { AgentConfigurationError } from "@/lib/agents/mutations";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  createConfiguredAgent: vi.fn(),
  cloneAgent: vi.fn(),
  setAgentTools: vi.fn(),
  sandboxFindMany: vi.fn(),
  stopSandboxAction: vi.fn(),
  updateAgent: vi.fn(),
  updateProvider: vi.fn(),
  agentFindFirst: vi.fn(),
  agentUpdateMany: vi.fn(),
  createConversation: vi.fn(),
  renameConsoleConversation: vi.fn(),
  generateConsoleConversationTitle: vi.fn(),
  deleteConsoleConversation: vi.fn(),
  updateAgentModelSelection: vi.fn(),
  getProvider: vi.fn(),
  workspaceUpdate: vi.fn(),
  startProcess: vi.fn(),
  materializeAgentRelease: vi.fn(),
  deleteManagedAgent: vi.fn(),
  redirect: vi.fn(),
  publishAgentRelease: vi.fn(),
  unpublishAgentListing: vi.fn(),
  withdrawPendingAgentRelease: vi.fn(),
  bindAgentWorkspaceResource: vi.fn(),
  deploymentFindFirst: vi.fn(),
  effectiveStatus: vi.fn(),
  startDeployment: vi.fn(),
  mcpRpc: vi.fn(),
  prepareAgentResourceReview: vi.fn(),
  applyAgentResourceReview: vi.fn(),
}));

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
      updateMany: mocks.agentUpdateMany,
    },
    deployment: {
      findFirst: mocks.deploymentFindFirst,
    },
    workspace: { update: mocks.workspaceUpdate },
    sandbox: { findMany: mocks.sandboxFindMany },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({
  startProcess: mocks.startProcess,
  effectiveStatus: mocks.effectiveStatus,
}));
vi.mock("@/lib/workspace/actions", () => ({
  startDeploymentAction: mocks.startDeployment,
}));
vi.mock("@/lib/process/mcp-client", () => ({ mcpRpc: mocks.mcpRpc }));
vi.mock("@/lib/sandboxes/actions", () => ({
  stopSandboxAction: mocks.stopSandboxAction,
}));
vi.mock("@/lib/agents/mutations", () => ({
  cloneAgent: mocks.cloneAgent,
  createConfiguredAgent: mocks.createConfiguredAgent,
  AgentConfigurationError: class AgentConfigurationError extends Error {},
  updateAgent: mocks.updateAgent,
  setAgentTools: mocks.setAgentTools,
  bindAgentWorkspaceResource: mocks.bindAgentWorkspaceResource,
  deleteAgent: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: mocks.updateProvider,
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  addProviderModels: vi.fn(),
  updateProviderModel: vi.fn(),
  deleteProviderModel: vi.fn(),
  ProviderModelError: class ProviderModelError extends Error {},
  createConversation: mocks.createConversation,
  renameConsoleConversation: mocks.renameConsoleConversation,
  deleteConsoleConversation: mocks.deleteConsoleConversation,
  updateAgentModelSelection: mocks.updateAgentModelSelection,
}));
vi.mock("@/lib/agents/resource-apply", () => ({
  prepareAgentResourceReview: mocks.prepareAgentResourceReview,
  applyAgentResourceReview: mocks.applyAgentResourceReview,
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
  stopAgentRuntimeAction,
  createAgentAction,
  cloneAgentAction,
  deleteAgentAction,
  pinAgentAction,
  installAgentFromMarketAction,
  updateAgentAction,
  enableAgentResourceAction,
  previewAgentResourceAction,
  updateAgentModelAction,
  updateProviderAction,
  updateWorkspaceModelPreferenceAction,
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
    runtimeKind: "pi-sdk",
    retiredAt: null,
    runtime: null,
  });
}

describe("Agent runtime stop boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.sandboxFindMany.mockResolvedValue([]);
  });

  it("uses the shared workspace-scoped stop lifecycle for every persisted Agent sandbox", async () => {
    mocks.sandboxFindMany.mockResolvedValue([
      { id: "template" },
      { id: "conversation" },
      { id: "delegation" },
    ]);
    expect(await stopAgentRuntimeAction({}, runtimeForm())).toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.sandboxFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        OR: [
          { agentLinks: { some: { agentId: "agent-1" } } },
          { conversations: { some: { agentId: "agent-1" } } },
          {
            a2aContexts: { some: { agentId: "agent-1", targetKind: "local" } },
          },
        ],
      },
      select: { id: true },
    });
    expect(
      mocks.stopSandboxAction.mock.calls.map((call) => {
        const form = call[0] as FormData;
        return [form.get("workspace"), form.get("sandboxId")];
      }),
    ).toEqual([
      ["acme", "template"],
      ["acme", "conversation"],
      ["acme", "delegation"],
    ]);
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it.each([
    "signed-out",
    "workspace-missing",
    "agent-missing",
    "endpoint-owned",
  ])("does not enumerate or stop sandboxes when %s", async (condition) => {
    if (condition === "signed-out")
      mocks.getCurrentUser.mockResolvedValue(null);
    if (condition === "workspace-missing")
      mocks.getWorkspaceForUser.mockResolvedValue(null);
    if (condition === "agent-missing")
      mocks.agentFindFirst.mockResolvedValue(null);
    if (condition === "endpoint-owned")
      mocks.agentFindFirst.mockResolvedValue({
        publicRuntimeAllocation: { id: "allocation" },
      });
    expect(await stopAgentRuntimeAction({}, runtimeForm())).toEqual({
      error: ["signed-out", "workspace-missing"].includes(condition)
        ? "Not authorized."
        : "Agent not found.",
    });
    expect(mocks.sandboxFindMany).not.toHaveBeenCalled();
    expect(mocks.stopSandboxAction).not.toHaveBeenCalled();
  });

  it("returns strict shared teardown failures without claiming a successful stop", async () => {
    mocks.sandboxFindMany.mockResolvedValue([{ id: "conversation" }]);
    mocks.stopSandboxAction.mockRejectedValue(
      new Error("Session MCP cleanup failed"),
    );
    expect(await stopAgentRuntimeAction({}, runtimeForm())).toEqual({
      error: "Session MCP cleanup failed",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("native draft creation actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      models: ["model-1"],
    });
    mocks.createConfiguredAgent.mockResolvedValue({ id: "agent-1" });
  });
  function createForm() {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("name", "Native draft");
    form.set("providerId", "provider-1");
    form.set("model", "model-1");
    return form;
  }
  it.each([undefined, "pi-sdk"])(
    "creates a lazy native draft for runtime %s without starting it",
    async (runtime) => {
      const form = createForm();
      if (runtime) form.set("runtime", runtime);
      await createAgentAction(form);
      expect(mocks.createConfiguredAgent).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          name: "Native draft",
          providerId: "provider-1",
          model: "model-1",
        }),
        { deploymentIds: [], installedSkillIds: [], toolkitIds: [] },
        { runtime: "pi-sdk" },
      );
      expect(mocks.startProcess).not.toHaveBeenCalled();
      expect(mocks.redirect).toHaveBeenCalledWith(
        "/app/acme/work?agent=agent-1",
      );
    },
  );
  it.each([
    "pi",
    "hermes",
    "claude-code",
    "dsh",
    "hermes-rpc",
    "toolloop",
    "unknown",
  ])(
    "rejects executable legacy runtime %s before provisioning",
    async (runtime) => {
      const form = createForm();
      form.set("runtime", runtime);
      await expect(createAgentAction(form)).rejects.toThrow("Only native Pi");
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
    },
  );
  it.each(["signed-out", "workspace-missing"])(
    "does not provision when %s",
    async (condition) => {
      if (condition === "signed-out")
        mocks.getCurrentUser.mockResolvedValue(null);
      else mocks.getWorkspaceForUser.mockResolvedValue(null);
      await createAgentAction(createForm());
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "stale"])(
    "rejects a %s model before provisioning",
    async (condition) => {
      const form = createForm();
      if (condition === "missing") form.delete("model");
      else form.set("model", "not-available");
      await expect(createAgentAction(form)).rejects.toThrow(
        "Choose an available model.",
      );
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
    },
  );
  it("does not start or redirect after draft record creation fails", async () => {
    mocks.createConfiguredAgent.mockRejectedValue(
      new Error("Sandbox record creation failed"),
    );
    await expect(createAgentAction(createForm())).rejects.toThrow(
      "Sandbox record creation failed",
    );
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("native draft clone actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.cloneAgent.mockResolvedValue({
      id: "agent-copy",
      runtimeKind: "pi-sdk",
    });
  });
  it("opens the fresh native draft without starting a runtime", async () => {
    await cloneAgentAction(runtimeForm());
    expect(mocks.cloneAgent).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      undefined,
      undefined,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/app/acme/work?agent=agent-copy",
    );
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
  it("passes explicit history-copy choices without implicitly requesting authority", async () => {
    const form = runtimeForm();
    form.set("cloneOptions", "1");
    form.set("copyConversations", "on");
    form.set("cloneName", " Historical copy ");
    await cloneAgentAction(form);
    expect(mocks.cloneAgent).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "Historical copy",
      {
        copyMcp: false,
        copySkills: false,
        copyToolkits: false,
        copySandboxes: false,
        copySubAgents: false,
        copyConversations: true,
      },
    );
  });
  it("propagates authority-copy rejection without starting or opening a copy", async () => {
    mocks.cloneAgent.mockRejectedValue(
      new AgentConfigurationError(
        "Copies require fresh capability authorization.",
      ),
    );
    const form = runtimeForm();
    form.set("cloneOptions", "1");
    form.set("copyMcp", "on");
    await expect(cloneAgentAction(form)).rejects.toThrow(
      "fresh capability authorization",
    );
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("provider save without legacy runtime projection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.getProvider.mockResolvedValue({
      id: "provider-1",
      name: "Provider",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret",
    });
  });
  function providerForm() {
    const form = runtimeForm();
    form.set("providerId", "provider-1");
    form.set("name", "Provider");
    form.set("format", "openai");
    form.set("baseUrl", "https://provider.test/v1");
    return form;
  }
  it("saves provider metadata without enumerating or projecting old Agents", async () => {
    expect(await updateProviderAction({}, providerForm())).toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.updateProvider).toHaveBeenCalledOnce();
    expect(mocks.agentFindFirst).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
  it("preserves owner-only provider mutation authorization", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      ownerId: "other",
    });
    expect(await updateProviderAction({}, providerForm())).toEqual({
      error: "Not authorized.",
    });
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });
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
  });

  it("opens a fresh native template draft without starting it", async () => {
    const form = new FormData();
    form.set("workspace", "acme");
    form.set("releaseId", "release-1");
    form.set("idempotencyKey", "request-1");

    await installAgentFromMarketAction(form);

    expect(mocks.startProcess).not.toHaveBeenCalled();
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

  it("saves model changes and refreshes the chat workspace", async () => {
    mocks.updateAgentModelSelection.mockResolvedValueOnce("native");
    const form = runtimeForm();
    form.set("providerId", "provider-1");
    form.set("model", "gpt-5");

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
    });

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/work");
  });

  it("keeps model changes as drafts without runtime synchronization", async () => {
    const form = runtimeForm();
    form.set("providerId", "provider-1");
    form.set("model", "gpt-5");
    await expect(updateAgentModelAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
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

describe("conversation title failure boundaries", () => {
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
    mocks.sandboxFindMany.mockResolvedValue([]);
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it.each([updateAgentAction, updateAgentModelAction, stopAgentRuntimeAction])(
    "rejects missing manageable agents before runtime mutations",
    async (action) => {
      mocks.agentFindFirst.mockResolvedValue(null);
      await expect(action({}, runtimeForm())).resolves.toEqual({
        error: "Agent not found.",
      });
      expect(mocks.updateAgent).not.toHaveBeenCalled();
      expect(mocks.stopSandboxAction).not.toHaveBeenCalled();
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

  it.each([updateAgentAction, updateAgentModelAction, stopAgentRuntimeAction])(
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

  it("saves draft Agent changes without runtime projection", async () => {
    await expect(updateAgentAction({}, runtimeForm())).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.setAgentTools).toHaveBeenCalledOnce();
  });

  it("returns a saved timestamp when stopping succeeds and a safe fallback for unknown stop errors", async () => {
    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    mocks.sandboxFindMany.mockRejectedValueOnce("unknown");
    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: "Could not stop the Agent runtime.",
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
});

describe("standalone resource review and published Apply", () => {
  const scope = {
    workspaceId: "workspace-1",
    userId: "user-1",
    agentId: "agent-1",
    resourceKind: "mcp",
    resourceId: "owned-mcp",
  };
  const review = {
    agentId: "agent-1",
    resourceId: "owned-mcp",
    resourceKind: "mcp",
    expectedRevisionId: "revision-before",
    reviewReceipt: "review-receipt",
    expiresAt: "2026-10-23T12:00:00.000Z",
    sourceChecksum: "source-checksum",
    tools: [
      { name: "owned_echo", inputSchema: { type: "object", properties: {} } },
    ],
    tested: true,
  };

  class ResourceReviewError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthorizedAgent();
    mocks.prepareAgentResourceReview.mockResolvedValue(review);
    mocks.applyAgentResourceReview.mockResolvedValue({
      id: "revision-after",
      version: 2,
      config: {},
    });
  });

  function resourceForm() {
    const form = runtimeForm();
    form.set("resourceKind", "mcp");
    form.set("resourceId", "owned-mcp");
    return form;
  }

  function applyForm() {
    const form = resourceForm();
    form.set("confirm", "yes");
    form.set("expectedRevisionId", "revision-before");
    form.set("reviewReceipt", "review-receipt");
    form.set("allowedToolNames", JSON.stringify(["owned_echo"]));
    return form;
  }

  function expectNoLegacyBinding() {
    expect(mocks.startDeployment).not.toHaveBeenCalled();
    expect(mocks.mcpRpc).not.toHaveBeenCalled();
    expect(mocks.bindAgentWorkspaceResource).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  }

  it("previews the selected MCP through the review service without applying it", async () => {
    expect(await previewAgentResourceAction({}, resourceForm())).toMatchObject(
      review,
    );
    expect(mocks.prepareAgentResourceReview).toHaveBeenCalledExactlyOnceWith(
      scope,
    );
    expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
    expectNoLegacyBinding();
  });

  it("previews a Skill using the same workspace-scoped review contract", async () => {
    const skillReview = {
      ...review,
      resourceKind: "skill",
      resourceId: "skill-1",
      tools: undefined,
      tested: undefined,
      skill: { name: "Reviewed Skill" },
    };
    mocks.prepareAgentResourceReview.mockResolvedValue(skillReview);
    const form = resourceForm();
    form.set("resourceKind", "skill");
    form.set("resourceId", "skill-1");
    expect(await previewAgentResourceAction({}, form)).toMatchObject(
      skillReview,
    );
    expect(mocks.prepareAgentResourceReview).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      resourceKind: "skill",
      resourceId: "skill-1",
    });
    expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
    expectNoLegacyBinding();
  });

  it.each([
    "confirm",
    "expectedRevisionId",
    "reviewReceipt",
    "allowedToolNames",
  ])("refuses Apply without explicit %s", async (field) => {
    const form = applyForm();
    form.delete(field);
    expect(await enableAgentResourceAction({}, form)).toMatchObject({
      error:
        field === "confirm" ? "resource_binding_consent" : "reviewRequired",
    });
    expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
    expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
    expectNoLegacyBinding();
  });

  it.each(["expectedRevisionId", "reviewReceipt"])(
    "refuses an empty %s instead of preparing implicitly",
    async (field) => {
      const form = applyForm();
      form.set(field, "");
      expect(await enableAgentResourceAction({}, form)).toMatchObject({
        error: "reviewRequired",
      });
      expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
      expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
      expectNoLegacyBinding();
    },
  );

  it("does not accept the former confirmation-only draft-binding request", async () => {
    const form = resourceForm();
    form.set("confirm", "yes");
    expect(await enableAgentResourceAction({}, form)).toMatchObject({
      error: "reviewRequired",
    });
    expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
    expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
    expectNoLegacyBinding();
  });

  it("forwards the reviewed revision and explicit tools to publication", async () => {
    expect(await enableAgentResourceAction({}, applyForm())).toMatchObject({
      enabled: true,
      bound: true,
      agentId: "agent-1",
      revisionId: "revision-after",
    });
    expect(mocks.applyAgentResourceReview).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      expectedRevisionId: "revision-before",
      reviewReceipt: "review-receipt",
      allowedToolNames: ["owned_echo"],
    });
    expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
    expectNoLegacyBinding();
  });

  it("preserves an explicit empty MCP tool selection", async () => {
    const form = applyForm();
    form.set("allowedToolNames", "[]");
    expect(await enableAgentResourceAction({}, form)).toMatchObject({
      enabled: true,
      revisionId: "revision-after",
    });
    expect(mocks.applyAgentResourceReview).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      expectedRevisionId: "revision-before",
      reviewReceipt: "review-receipt",
      allowedToolNames: [],
    });
    expectNoLegacyBinding();
  });

  it("publishes a reviewed Skill without requiring MCP tool selection", async () => {
    const form = applyForm();
    form.set("resourceKind", "skill");
    form.set("resourceId", "skill-1");
    form.delete("allowedToolNames");
    expect(await enableAgentResourceAction({}, form)).toMatchObject({
      enabled: true,
      bound: true,
      agentId: "agent-1",
      revisionId: "revision-after",
    });
    expect(mocks.applyAgentResourceReview).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      resourceKind: "skill",
      resourceId: "skill-1",
      expectedRevisionId: "revision-before",
      reviewReceipt: "review-receipt",
    });
    expectNoLegacyBinding();
  });

  it.each([
    "signed-out",
    "workspace-missing",
    "agent-missing",
    "endpoint-owned",
  ])(
    "rejects preview and Apply before service access when %s",
    async (condition) => {
      if (condition === "signed-out")
        mocks.getCurrentUser.mockResolvedValue(null);
      if (condition === "workspace-missing")
        mocks.getWorkspaceForUser.mockResolvedValue(null);
      if (condition === "agent-missing")
        mocks.agentFindFirst.mockResolvedValue(null);
      if (condition === "endpoint-owned")
        mocks.agentFindFirst.mockResolvedValue({
          publicRuntimeAllocation: { id: "allocation" },
        });
      expect(
        await previewAgentResourceAction({}, resourceForm()),
      ).toMatchObject({
        error: "resource_binding_unavailable",
      });
      expect(await enableAgentResourceAction({}, applyForm())).toMatchObject({
        error: "resource_binding_unavailable",
      });
      expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
      expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
      expectNoLegacyBinding();
    },
  );

  it.each([
    "reviewRequired",
    "reviewExpired",
    "revisionPreparationRequired",
    "resourceChanged",
    "AGENT_REVISION_CONFLICT",
  ])(
    "propagates Apply domain failure %s without claiming success",
    async (code) => {
      mocks.applyAgentResourceReview.mockRejectedValue(
        new ResourceReviewError(code),
      );
      expect(await enableAgentResourceAction({}, applyForm())).toEqual({
        error: code,
      });
      expect(mocks.applyAgentResourceReview).toHaveBeenCalledOnce();
      expect(mocks.prepareAgentResourceReview).not.toHaveBeenCalled();
      expectNoLegacyBinding();
    },
  );

  it.each(["revisionPreparationRequired", "resourceChanged"])(
    "propagates preview failure %s without creating an Apply request",
    async (code) => {
      mocks.prepareAgentResourceReview.mockRejectedValue(
        new ResourceReviewError(code),
      );
      expect(await previewAgentResourceAction({}, resourceForm())).toEqual({
        error: code,
      });
      expect(mocks.applyAgentResourceReview).not.toHaveBeenCalled();
      expectNoLegacyBinding();
    },
  );
});
