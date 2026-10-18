// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  updateAgentModelSelection,
  bindHermesAgentModelProvider,
  setHermesRuntimeEnv,
  setHermesConversationSelection,
  updateAgent,
} from "@/lib/agents/mutations";
import { defaultProviderModel } from "@/lib/agents/model-catalog";
import { hermesProviderName } from "@/lib/agents/hermes/config";
import type { AgentConfig } from "@/lib/agents/mutations";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  agent: { findFirst: vi.fn(), updateMany: vi.fn() },
  modelProvider: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  providerModel: {
    createMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  conversation: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentModelProvider: { deleteMany: vi.fn(), createMany: vi.fn() },
  chatAssistant: { findFirst: vi.fn() },
  knowledgeBase: { findFirst: vi.fn() },
  workspace: { findFirst: vi.fn() },
  agentRuntime: { findFirst: vi.fn() },
  sandbox: { updateMany: vi.fn() },
  deployment: { updateMany: vi.fn() },
  marketInstall: { findFirst: vi.fn() },
  marketRelease: { findFirst: vi.fn() },
  agentPiPackage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  agentSandbox: { findMany: vi.fn() },
  a2ATask: { findFirst: vi.fn() },
  workSession: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (operation: (client: typeof tx) => unknown) => operation(tx),
  },
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: vi.fn() }));

const provider = {
  id: "provider",
  name: "Custom",
  format: "openai",
  baseUrl: "https://models.test/v1",
  models: ["model", "other"],
};
const selection = {
  profile: "research",
  provider: "custom:provider",
  model: "model",
};

describe("round two agent mutation safety policies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tx.$queryRaw.mockResolvedValue([provider]);
    tx.modelProvider.findUnique.mockResolvedValue(provider);
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      runtimeKind: "pi",
      modelProviders: [],
    });
    tx.sandbox.updateMany.mockResolvedValue({ count: 1 });
    tx.deployment.updateMany.mockResolvedValue({ count: 1 });
    tx.conversation.create.mockResolvedValue({ id: "new-conversation" });
  });

  it.each([addProviderModels, updateProviderModel, deleteProviderModel])(
    "refuses to edit models of a provider outside the workspace",
    async (operation) => {
      tx.$queryRaw.mockResolvedValue([]);
      const promise =
        operation === addProviderModels
          ? addProviderModels("workspace", "foreign", [
              defaultProviderModel("new"),
            ])
          : operation === updateProviderModel
            ? updateProviderModel(
                "workspace",
                "foreign",
                defaultProviderModel("model"),
              )
            : deleteProviderModel("workspace", "foreign", "model");
      await expect(promise).rejects.toThrow("Provider not found.");
      expect(tx.providerModel.createMany).not.toHaveBeenCalled();
      expect(tx.providerModel.upsert).not.toHaveBeenCalled();
      expect(tx.providerModel.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each([{ ids: ["new", "new"] }, { ids: ["model"] }])(
    "rejects duplicate model identifiers $ids without changing the provider",
    async ({ ids }) => {
      await expect(
        addProviderModels(
          "workspace",
          "provider",
          ids.map(defaultProviderModel),
        ),
      ).rejects.toThrow("already exists");
      expect(tx.modelProvider.update).not.toHaveBeenCalled();
    },
  );

  it("adds new model metadata and retains previous model selection order", async () => {
    await addProviderModels("workspace", "provider", [
      defaultProviderModel("new"),
    ]);
    expect(tx.providerModel.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          modelId: "new",
          providerId: "provider",
          source: "manual",
        }),
      ],
    });
    expect(tx.modelProvider.update).toHaveBeenCalledWith({
      where: { id: "provider" },
      data: { models: ["model", "other", "new"] },
    });
  });

  it("rejects updates and deletions of nonexistent model IDs", async () => {
    await expect(
      updateProviderModel(
        "workspace",
        "provider",
        defaultProviderModel("unknown"),
      ),
    ).rejects.toThrow("Model not found.");
    await expect(
      deleteProviderModel("workspace", "provider", "unknown"),
    ).rejects.toThrow("Model not found.");
    tx.modelProvider.findUnique.mockResolvedValue(null);
    await expect(
      deleteProviderModel("workspace", "provider", "model"),
    ).rejects.toThrow("Model not found.");
    expect(tx.providerModel.deleteMany).not.toHaveBeenCalled();
  });

  it.each([null, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }])(
    "preserves existing prices for metadata-only model edits %j",
    async (cost) => {
      tx.providerModel.findUnique.mockResolvedValue(cost ? { cost } : null);
      const model = defaultProviderModel("model");
      delete model.cost;
      await updateProviderModel("workspace", "provider", model);
      expect(tx.providerModel.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            source: "manual",
            ...(cost ? { cost } : {}),
          }),
        }),
      );
    },
  );

  it.each([
    "agent",
    "chatAssistant",
    "knowledgeBase",
    "workspace",
    "conversation",
  ] as const)("protects model references held by %s", async (resource) => {
    tx[resource].findFirst.mockResolvedValue(null);
    tx.agent.findFirst.mockResolvedValue(null);
    tx[resource].findFirst.mockResolvedValue({ id: "in-use" });
    await expect(
      deleteProviderModel("workspace", "provider", "model"),
    ).rejects.toThrow("in use");
    expect(tx.providerModel.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes an unused model and removes only its catalog identifier", async () => {
    tx.agent.findFirst.mockResolvedValue(null);
    await deleteProviderModel("workspace", "provider", "model");
    expect(tx.providerModel.deleteMany).toHaveBeenCalledWith({
      where: { providerId: "provider", modelId: "model" },
    });
    expect(tx.modelProvider.update).toHaveBeenCalledWith({
      where: { id: "provider" },
      data: { models: ["other"] },
    });
  });

  it("leaves a missing agent unchanged and clears selection when its provider is unavailable", async () => {
    tx.agent.findFirst.mockResolvedValueOnce(null);
    await expect(
      updateAgentModelSelection("workspace", "missing", ["provider"], "model"),
    ).resolves.toBeUndefined();
    expect(tx.agent.updateMany).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([]);
    await updateAgentModelSelection("workspace", "agent", ["foreign"], "model");
    expect(tx.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerId: null, model: null } }),
    );
  });

  it.each([
    ["pi", "missing", "openai", "Unknown or unavailable model"],
    ["claude-code", "model", "unsupported-format", "does not support"],
  ])(
    "rejects incompatible model/runtime %s/%s/%s",
    async (runtimeKind, model, format, error) => {
      tx.agent.findFirst.mockResolvedValue({ id: "agent", runtimeKind });
      tx.$queryRaw.mockResolvedValue([{ ...provider, format }]);
      await expect(
        updateAgentModelSelection("workspace", "agent", ["provider"], model),
      ).rejects.toThrow(error);
      expect(tx.agent.updateMany).not.toHaveBeenCalled();
    },
  );

  it("clears an explicit provider selection when requested IDs are empty", async () => {
    await updateAgentModelSelection("workspace", "agent", [], "model");
    expect(tx.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerId: null, model: null } }),
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("replaces Hermes providers with unique accessible bindings and clears conversations tied to removals", async () => {
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      runtimeKind: "hermes",
      modelProviders: [{ providerId: "old" }, { providerId: "provider" }],
    });
    tx.$queryRaw.mockImplementation(async (_sql, id) =>
      id === "foreign" ? [] : [provider],
    );
    await expect(
      updateAgentModelSelection(
        "workspace",
        "agent",
        ["provider", "", "provider", "foreign"],
        "ignored",
      ),
    ).resolves.toBe("hermes");
    expect(tx.agentModelProvider.createMany).toHaveBeenCalledWith({
      data: [{ agentId: "agent", providerId: "provider" }],
    });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { hermesProvider: null, hermesModel: null },
      }),
    );
  });

  it("does not reset conversations when Hermes provider bindings are retained", async () => {
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      runtimeKind: "hermes",
      modelProviders: [{ providerId: "provider" }],
    });
    await updateAgentModelSelection("workspace", "agent", ["provider"], null);
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    "missing-agent",
    "missing-alias",
    "provider-deleted",
    "model-removed",
  ])("rejects a stale Hermes model binding: %s", async (condition) => {
    tx.modelProvider.findMany.mockResolvedValue([{ id: "provider" }]);
    tx.modelProvider.findFirst.mockResolvedValue({ id: "provider" });
    if (condition === "missing-agent")
      tx.agent.findFirst.mockResolvedValue(null);
    if (condition === "missing-alias")
      tx.modelProvider.findMany.mockResolvedValue([]);
    if (condition === "provider-deleted") tx.$queryRaw.mockResolvedValue([]);
    if (condition === "model-removed")
      tx.modelProvider.findFirst.mockResolvedValue(null);
    await expect(
      bindHermesAgentModelProvider(
        "workspace",
        "agent",
        `custom:${hermesProviderName("provider")}`,
        "model",
      ),
    ).rejects.toThrow(
      condition === "missing-agent"
        ? "Hermes agent not found"
        : "not available",
    );
    expect(tx.agentModelProvider.createMany).not.toHaveBeenCalled();
  });

  it("binds a valid bare Hermes provider alias without duplicating existing links", async () => {
    tx.modelProvider.findMany.mockResolvedValue([{ id: "provider" }]);
    tx.modelProvider.findFirst.mockResolvedValue({ id: "provider" });
    await expect(
      bindHermesAgentModelProvider(
        "workspace",
        "agent",
        hermesProviderName("provider"),
        "model",
      ),
    ).resolves.toBe(hermesProviderName("provider"));
    expect(tx.agentModelProvider.createMany).toHaveBeenCalledWith({
      data: [{ agentId: "agent", providerId: "provider" }],
      skipDuplicates: true,
    });
  });

  it.each([null, { sandbox: { workspaceId: "foreign" } }])(
    "does not project environment into missing or foreign runtime %j",
    async (runtime) => {
      tx.agentRuntime.findFirst.mockResolvedValue(runtime);
      await expect(
        setHermesRuntimeEnv("workspace", "agent", { CUSTOM: "value" }),
      ).resolves.toBe(false);
      expect(tx.sandbox.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], "invalid", { custom: true }])(
    "projects environment while preserving only object install config %j",
    async (installCfg) => {
      tx.agentRuntime.findFirst.mockResolvedValue({
        sandbox: {
          id: "sandbox",
          workspaceId: "workspace",
          deploymentId: "deployment",
          config: { owner: "agent", env: { OLD: "old" } },
          deployment: { installCfg },
        },
      });
      await expect(
        setHermesRuntimeEnv("workspace", "agent", { CUSTOM: "new" }),
      ).resolves.toBe(true);
      expect(tx.deployment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            installCfg: {
              ...(installCfg &&
              typeof installCfg === "object" &&
              !Array.isArray(installCfg)
                ? installCfg
                : {}),
              env: { CUSTOM: "new" },
            },
          },
        }),
      );
    },
  );

  it.each(["sandbox", "deployment"] as const)(
    "rejects incomplete environment projection into %s",
    async (resource) => {
      tx.agentRuntime.findFirst.mockResolvedValue({
        sandbox: {
          id: "sandbox",
          workspaceId: "workspace",
          deploymentId: "deployment",
          config: {},
          deployment: { installCfg: {} },
        },
      });
      tx[resource].updateMany.mockResolvedValue({ count: 0 });
      await expect(
        setHermesRuntimeEnv("workspace", "agent", {}),
      ).rejects.toThrow("environment projection");
    },
  );

  it.each([
    { profile: "../escape" },
    { provider: null },
    { model: null },
    { provider: "" },
    { provider: "x".repeat(129) },
    { model: "" },
    { model: "x".repeat(513) },
  ])(
    "rejects invalid Hermes selection %j before accessing the database",
    async (override) => {
      await expect(
        setHermesConversationSelection("workspace", "agent", null, {
          ...selection,
          ...override,
        }),
      ).resolves.toBeNull();
      expect(tx.agent.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { id: "agent", publicRuntimeAllocation: { id: "allocation" } },
  ])(
    "does not edit selection for a missing or endpoint-owned agent %j",
    async (agent) => {
      tx.agent.findFirst.mockResolvedValue(agent);
      await expect(
        setHermesConversationSelection("workspace", "agent", null, selection),
      ).resolves.toBeNull();
      expect(tx.conversation.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { title: "msg:telegram" },
    { publicApiConversation: { id: "api" } },
    { workSession: { status: "running" } },
  ])("protects non-console or running conversations %j", async (override) => {
    tx.conversation.findFirst.mockResolvedValue(
      override && {
        id: "conversation",
        title: null,
        _count: { messages: 0 },
        ...override,
      },
    );
    await expect(
      setHermesConversationSelection(
        "workspace",
        "agent",
        "conversation",
        selection,
      ),
    ).resolves.toBeNull();
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });

  it("forks a populated conversation when its profile changes", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation",
      hermesProfile: null,
      _count: { messages: 1 },
    });
    await expect(
      setHermesConversationSelection(
        "workspace",
        "agent",
        "conversation",
        selection,
      ),
    ).resolves.toEqual({ conversationId: "new-conversation", created: true });
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "new-conversation" },
      data: {
        runtimeSessionId: "new-conversation",
        runtimeSessionKey: "agent:agent:console:new-conversation",
      },
    });
  });

  it.each(["idle", "waiting_user", "completed", "failed"])(
    "updates editable work conversation in place for status %s",
    async (status) => {
      tx.conversation.findFirst.mockResolvedValue({
        id: "conversation",
        hermesProfile: null,
        _count: { messages: 9 },
        workSession: { status },
      });
      await expect(
        setHermesConversationSelection(
          "workspace",
          "agent",
          "conversation",
          selection,
        ),
      ).resolves.toEqual({ conversationId: "conversation", created: false });
      expect(tx.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hermesProfile: "research",
            runtimeSessionId: "conversation",
          }),
        }),
      );
      expect(tx.conversation.create).not.toHaveBeenCalled();
    },
  );

  it("preserves session identity when only the model selection changes", async () => {
    tx.conversation.findFirst.mockResolvedValue({
      id: "conversation",
      hermesProfile: "research",
      _count: { messages: 9 },
    });
    await expect(
      setHermesConversationSelection(
        "workspace",
        "agent",
        "conversation",
        selection,
      ),
    ).resolves.toEqual({ conversationId: "conversation", created: false });
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation" },
      data: {
        hermesProfile: "research",
        hermesProvider: "custom:provider",
        hermesModel: "model",
      },
    });
  });

  it("creates a default-profile conversation with null native overrides", async () => {
    await expect(
      setHermesConversationSelection("workspace", "agent", null, {
        profile: "default",
        provider: null,
        model: null,
      }),
    ).resolves.toEqual({ conversationId: "new-conversation", created: true });
    expect(tx.conversation.create).toHaveBeenCalledWith({
      data: {
        agentId: "agent",
        hermesProfile: null,
        hermesProvider: null,
        hermesModel: null,
      },
    });
  });
  describe("package binding transitions", () => {
    const cfg: AgentConfig = {
      name: "Agent",
      systemPrompt: "Prompt",
      providerId: null,
      model: null,
      maxSteps: 8,
      piPackages: [{ marketInstallId: "install", releaseId: "current" }],
    };
    beforeEach(() => {
      tx.agent.findFirst.mockResolvedValue({
        id: "agent",
        runtimeKind: "pi-sdk",
        modelProviders: [],
      });
      tx.marketInstall.findFirst.mockResolvedValue({
        id: "install",
        listingId: "listing",
        status: "ready",
        currentReleaseId: "current",
        listing: { kind: "pi-package", status: "published" },
      });
      tx.marketRelease.findFirst.mockResolvedValue({
        id: "current",
        reviewStatus: "approved",
      });
      tx.agentPiPackage.findMany.mockResolvedValue([]);
      tx.agentSandbox.findMany.mockResolvedValue([]);
    });

    it.each([
      { piPackages: null },
      { piPackages: [null] },
      { piPackages: [{ marketInstallId: 1, releaseId: "current" }] },
      { piPackages: [{ marketInstallId: "", releaseId: "current" }] },
      { piPackages: [{ marketInstallId: "install", releaseId: 1 }] },
      { piPackages: [{ marketInstallId: "install", releaseId: "" }] },
      {
        piPackages: [
          { marketInstallId: "install", releaseId: "current", injected: true },
        ],
      },
    ])(
      "rejects malformed package bindings $piPackages",
      async ({ piPackages }) => {
        await expect(
          updateAgent("workspace", "agent", {
            ...cfg,
            piPackages: piPackages as AgentConfig["piPackages"],
          }),
        ).rejects.toThrow("pi_packages_invalid");
        expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
      },
    );

    it("refuses Pi packages on a runtime without package support", async () => {
      tx.agent.findFirst.mockResolvedValue({
        id: "agent",
        runtimeKind: "pi",
        modelProviders: [],
      });
      await expect(updateAgent("workspace", "agent", cfg)).rejects.toThrow(
        "pi_packages_runtime_unsupported",
      );
    });

    it.each([
      {
        packages: Array.from({ length: 17 }, (_, index) => ({
          marketInstallId: `install-${index}`,
          releaseId: "current",
        })),
        error: "Too many Pi packages",
      },
      {
        packages: [
          { marketInstallId: "install", releaseId: "one" },
          { marketInstallId: "install", releaseId: "two" },
        ],
        error: "Duplicate marketInstallId",
      },
    ])(
      "rejects invalid package set cardinality $error",
      async ({ packages, error }) => {
        await expect(
          updateAgent("workspace", "agent", { ...cfg, piPackages: packages }),
        ).rejects.toThrow(error);
        expect(tx.marketInstall.findFirst).not.toHaveBeenCalled();
        expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
      },
    );

    it.each([
      [null, "Unknown or inaccessible"],
      [
        { listing: { kind: "other", status: "published" }, status: "ready" },
        "not a pi-package",
      ],
      [
        {
          listing: { kind: "pi-package", status: "disabled" },
          status: "ready",
        },
        "not published",
      ],
      [
        {
          listing: { kind: "pi-package", status: "published" },
          status: "failed",
        },
        "not ready",
      ],
    ])("rejects unavailable market package %j", async (install, error) => {
      tx.marketInstall.findFirst.mockResolvedValue(install);
      await expect(updateAgent("workspace", "agent", cfg)).rejects.toThrow(
        error,
      );
      expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
    });

    it.each([null, { reviewStatus: "pending" }, { reviewStatus: "rejected" }])(
      "refuses unapproved package release %j",
      async (release) => {
        tx.marketRelease.findFirst.mockResolvedValue(release);
        await expect(updateAgent("workspace", "agent", cfg)).rejects.toThrow(
          "Release not approved",
        );
        expect(tx.agentPiPackage.createMany).not.toHaveBeenCalled();
      },
    );

    it("requires first-time package bindings to use the current approved release", async () => {
      await expect(
        updateAgent("workspace", "agent", {
          ...cfg,
          piPackages: [{ marketInstallId: "install", releaseId: "older" }],
        }),
      ).rejects.toThrow("pi_package_release_not_current");
      expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
    });

    it("retains an already-bound approved historical release without rewriting it", async () => {
      tx.agentPiPackage.findFirst.mockResolvedValue({ releaseId: "older" });
      tx.agentPiPackage.findMany.mockResolvedValue([
        { marketInstallId: "install", releaseId: "older" },
      ]);
      await updateAgent("workspace", "agent", {
        ...cfg,
        piPackages: [{ marketInstallId: "install", releaseId: "older" }],
      });
      expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
      expect(tx.a2ATask.findFirst).not.toHaveBeenCalled();
    });

    it.each(["task", "work"])(
      "refuses to change package bindings during active %s",
      async (busy) => {
        if (busy === "task")
          tx.a2ATask.findFirst.mockResolvedValue({ id: "task" });
        else tx.workSession.findFirst.mockResolvedValue({ id: "work" });
        await expect(updateAgent("workspace", "agent", cfg)).rejects.toThrow(
          "pi_package_agent_busy",
        );
        expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
      },
    );

    it("replaces changed package bindings atomically after approval and idleness checks", async () => {
      tx.agentPiPackage.findMany.mockResolvedValue([
        { marketInstallId: "old-install", releaseId: "old-release" },
      ]);
      await updateAgent("workspace", "agent", cfg);
      expect(tx.agentPiPackage.deleteMany).toHaveBeenCalledWith({
        where: { agentId: "agent" },
      });
      expect(tx.agentPiPackage.createMany).toHaveBeenCalledWith({
        data: [
          {
            agentId: "agent",
            marketInstallId: "install",
            releaseId: "current",
          },
        ],
      });
      expect(tx.a2ATask.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        tx.agentPiPackage.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it("clears explicit package bindings but leaves omitted bindings untouched", async () => {
      tx.agentPiPackage.findMany.mockResolvedValue([
        { marketInstallId: "install", releaseId: "current" },
      ]);
      await updateAgent("workspace", "agent", { ...cfg, piPackages: [] });
      expect(tx.agentPiPackage.deleteMany).toHaveBeenCalledOnce();
      expect(tx.agentPiPackage.createMany).not.toHaveBeenCalled();
      tx.agentPiPackage.deleteMany.mockClear();
      await updateAgent("workspace", "agent", {
        ...cfg,
        piPackages: undefined,
      });
      expect(tx.agentPiPackage.deleteMany).not.toHaveBeenCalled();
    });
  });
});
