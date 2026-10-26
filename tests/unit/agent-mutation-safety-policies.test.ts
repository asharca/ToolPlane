// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  updateAgentModelSelection,
  updateAgent,
} from "@/lib/agents/mutations";
import { defaultProviderModel } from "@/lib/agents/model-catalog";
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
  chatAssistant: { findFirst: vi.fn() },
  knowledgeBase: { findFirst: vi.fn() },
  workspace: { findFirst: vi.fn() },
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

describe("round two agent mutation safety policies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tx.$queryRaw.mockResolvedValue([provider]);
    tx.modelProvider.findUnique.mockResolvedValue(provider);
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      runtimeKind: "pi-sdk",
      retiredAt: null,
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

  it.each(["agent", "chatAssistant", "knowledgeBase", "workspace"] as const)(
    "protects model references held by %s",
    async (resource) => {
      tx[resource].findFirst.mockResolvedValue(null);
      tx.agent.findFirst.mockResolvedValue(null);
      tx[resource].findFirst.mockResolvedValue({ id: "in-use" });
      await expect(
        deleteProviderModel("workspace", "provider", "model"),
      ).rejects.toThrow("in use");
      expect(tx.providerModel.deleteMany).not.toHaveBeenCalled();
    },
  );

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
      updateAgentModelSelection("workspace", "missing", "provider", "model"),
    ).resolves.toBeUndefined();
    expect(tx.agent.updateMany).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([]);
    await updateAgentModelSelection("workspace", "agent", "foreign", "model");
    expect(tx.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerId: null, model: null } }),
    );
  });

  it.each([
    ["pi-sdk", "missing", "openai", "Unknown or unavailable model"],
    ["pi-sdk", "model", "unsupported-format", "does not support"],
  ])(
    "rejects incompatible model/runtime %s/%s/%s",
    async (runtimeKind, model, format, error) => {
      tx.agent.findFirst.mockResolvedValue({
        id: "agent",
        runtimeKind,
        retiredAt: null,
      });
      tx.$queryRaw.mockResolvedValue([{ ...provider, format }]);
      await expect(
        updateAgentModelSelection("workspace", "agent", "provider", model),
      ).rejects.toThrow(error);
      expect(tx.agent.updateMany).not.toHaveBeenCalled();
    },
  );

  it("clears an explicit provider selection when the requested provider is null", async () => {
    await updateAgentModelSelection("workspace", "agent", null, "model");
    expect(tx.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerId: null, model: null } }),
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["pi", "claude-code", "dsh"])(
    "rejects model/config changes for historical runtime %s without changing history",
    async (runtimeKind) => {
      tx.agent.findFirst.mockResolvedValue({
        id: "agent",
        runtimeKind,
        retiredAt: null,
      });
      await expect(
        updateAgentModelSelection("workspace", "agent", "provider", "model"),
      ).rejects.toThrow("Historical Agents are read-only");
      await expect(
        updateAgent("workspace", "agent", {
          name: "Changed",
          systemPrompt: null,
          providerId: null,
          model: null,
          maxSteps: 8,
        }),
      ).rejects.toThrow("Historical Agents are read-only");
      expect(tx.agent.updateMany).not.toHaveBeenCalled();
      expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    },
  );

  it("rejects configuration changes for a retired native Agent", async () => {
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      runtimeKind: "pi-sdk",
      retiredAt: new Date(),
    });
    await expect(
      updateAgentModelSelection("workspace", "agent", "provider", "model"),
    ).rejects.toThrow("Historical Agents are read-only");
    expect(tx.agent.updateMany).not.toHaveBeenCalled();
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
        retiredAt: null,
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

    it("refuses package edits on a historical runtime", async () => {
      tx.agent.findFirst.mockResolvedValue({
        id: "agent",
        runtimeKind: "pi",
        retiredAt: null,
      });
      await expect(updateAgent("workspace", "agent", cfg)).rejects.toThrow(
        "Historical Agents are read-only",
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

    it("accepts an explicitly selected approved historical default", async () => {
      await updateAgent("workspace", "agent", {
        ...cfg,
        piPackages: [{ marketInstallId: "install", releaseId: "older" }],
      });
      expect(tx.agentPiPackage.createMany).toHaveBeenCalledWith({
        data: [
          { agentId: "agent", marketInstallId: "install", releaseId: "older" },
        ],
      });
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
