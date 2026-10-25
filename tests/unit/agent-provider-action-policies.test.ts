// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelError } from "@/lib/agents/mutations";
import {
  addProviderModelAction,
  updateProviderModelAction,
  deleteProviderModelAction,
  testProviderModelAction,
  createProviderAction,
  updateProviderAction,
  deleteProviderAction,
  updateWorkspaceModelPreferenceAction,
} from "@/lib/agents/actions";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  provider: vi.fn(),
  save: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  complete: vi.fn(),
  workspaceUpdate: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/agents/queries", () => ({
  getProvider: mocks.provider,
  ORDINARY_AGENT_FILTER: {},
}));
vi.mock("@/lib/db", () => ({
  db: { workspace: { update: mocks.workspaceUpdate } },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.invalidate }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/agents/mutations", () => ({
  ProviderModelError: class extends Error {},
  addProviderModels: mocks.add,
  updateProviderModel: mocks.update,
  deleteProviderModel: mocks.remove,
  createProvider: mocks.createProvider,
  updateProvider: mocks.updateProvider,
  deleteProvider: mocks.deleteProvider,
}));
vi.mock("@/lib/agents/provider-model-refresh", () => ({
  refreshProviderModels: mocks.refresh,
  revalidateProviderViews: mocks.invalidate,
}));
vi.mock("@/lib/agents/model", () => ({
  buildModel: () => ({
    models: { completeSimple: mocks.complete },
    model: { id: "model" },
  }),
}));
vi.mock("@/lib/agents/channel-connections", () => ({}));
vi.mock("@/lib/agents/channel-pairing", () => ({}));
vi.mock("@/lib/agents/hermes/runtime", () => ({}));
vi.mock("@/lib/agents/market", () => ({}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({}));
vi.mock("@/lib/sandboxes/actions", () => ({}));
vi.mock("@/lib/process/supervisor", () => ({}));

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "acme",
    providerId: "provider",
    modelId: "test-model",
    name: "Provider",
    format: "openai",
    baseUrl: "https://provider.test/v1",
    apiKey: "secret-key",
    ...values,
  }))
    data.set(key, value);
  return data;
}
const prices = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

describe("round two provider configuration policies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "owner" });
    mocks.workspace.mockResolvedValue({ id: "workspace", ownerId: "owner" });
    mocks.provider.mockResolvedValue({
      id: "provider",
      format: "openai",
      baseUrl: "https://provider.test/v1",
      apiKey: "secret-key",
      models: ["test-model"],
    });
    mocks.createProvider.mockResolvedValue({ id: "created" });
    mocks.complete.mockResolvedValue({ stopReason: "stop" });
  });

  it.each([
    ["", "test-model"],
    ["provider", ""],
    ["provider", "x".repeat(201)],
    [
      "provider",
      Array.from({ length: 51 }, (_, index) => `model-${index}`).join(","),
    ],
  ])(
    "rejects invalid model batch provider=%s ids=%s before mutations",
    async (providerId, modelId) => {
      await expect(
        addProviderModelAction({}, form({ providerId, modelId })),
      ).resolves.toEqual({ error: "Enter between 1 and 50 valid model IDs." });
      expect(mocks.add).not.toHaveBeenCalled();
      expect(mocks.workspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["primaryType", "invalid"],
    ["contextWindow", "0"],
    ["contextWindow", "-1"],
    ["contextWindow", "1.5"],
    ["contextWindow", "Infinity"],
    ["contextWindow", "100000001"],
    ["maxInputTokens", "not-number"],
    ["maxOutputTokens", "-3"],
    ["name", "n".repeat(201)],
    ["group", "g".repeat(121)],
    ["cost", "invalid JSON"],
    ["cost", "x".repeat(16001)],
    ["cost", "false"],
    ["cost", "{}"],
    ["cost", JSON.stringify({ ...prices, input: -1 })],
    ["cost", JSON.stringify({ ...prices, output: "1" })],
    ["cost", JSON.stringify({ ...prices, cacheRead: null })],
    ["cost", JSON.stringify({ ...prices, tiers: {} })],
    [
      "cost",
      JSON.stringify({
        ...prices,
        tiers: Array.from({ length: 101 }, () => prices),
      }),
    ],
    [
      "cost",
      JSON.stringify({
        ...prices,
        tiers: [{ ...prices, inputTokensAbove: -1 }],
      }),
    ],
    [
      "cost",
      JSON.stringify({
        ...prices,
        tiers: [{ ...prices, inputTokensAbove: 1.5 }],
      }),
    ],
    ["cost", JSON.stringify({ ...prices, tiers: [{ inputTokensAbove: 1 }] })],
  ])("rejects invalid model metadata %s=%s", async (key, value) => {
    const data = form({ [key]: value });
    await expect(addProviderModelAction({}, data)).resolves.toEqual({
      error: "Check the model classification, token limits, and prices.",
    });
    await expect(updateProviderModelAction({}, data)).resolves.toEqual({
      error: "Check the model fields, token limits, and prices.",
    });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves finite token limits, tiered rates and only supported unique classifications", async () => {
    const data = form({
      contextWindow: "100000000",
      maxInputTokens: "1024",
      maxOutputTokens: "64",
      cost: JSON.stringify({
        ...prices,
        ignored: true,
        tiers: [{ ...prices, inputTokensAbove: 100, ignored: true }],
      }),
    });
    for (const value of ["reasoning", "reasoning", "not-capability"])
      data.append("capabilities", value);
    for (const value of ["image", "image", "not-modality"])
      data.append("inputModalities", value);
    await expect(updateProviderModelAction({}, data)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.update).toHaveBeenCalledWith(
      "workspace",
      "provider",
      expect.objectContaining({
        contextWindow: 100000000,
        maxInputTokens: 1024,
        maxOutputTokens: 64,
        capabilities: ["reasoning"],
        inputModalities: ["image"],
        cost: { ...prices, tiers: [{ ...prices, inputTokensAbove: 100 }] },
      }),
    );
  });

  it.each(["", "null"])(
    "supports clearing explicit model pricing using %s",
    async (cost) => {
      await expect(
        updateProviderModelAction({}, form({ cost })),
      ).resolves.toEqual({ savedAt: expect.any(Number) });
      expect(mocks.update).toHaveBeenCalledWith(
        "workspace",
        "provider",
        expect.objectContaining({
          cost: null,
          contextWindow: null,
          maxInputTokens: null,
          maxOutputTokens: null,
        }),
      );
    },
  );

  it.each([
    addProviderModelAction,
    updateProviderModelAction,
    deleteProviderModelAction,
  ])("enforces owner authorization for model mutations", async (action) => {
    mocks.workspace.mockResolvedValue({
      id: "workspace",
      ownerId: "someone-else",
    });
    await expect(action({}, form())).resolves.toEqual({
      error: "Not authorized.",
    });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    addProviderModelAction,
    updateProviderModelAction,
    deleteProviderModelAction,
  ])(
    "reports domain errors but hides unexpected model mutation details",
    async (action) => {
      for (const operation of [mocks.add, mocks.update, mocks.remove])
        operation.mockRejectedValue(new ProviderModelError("Model is in use"));
      await expect(action({}, form())).resolves.toEqual({
        error: "Model is in use",
      });
      for (const operation of [mocks.add, mocks.update, mocks.remove])
        operation.mockRejectedValue(new Error("secret database detail"));
      await expect(action({}, form())).resolves.toEqual({
        error: "Could not save the model.",
      });
    },
  );

  it("normalizes comma-separated model batches but retains shared supported classifications", async () => {
    const data = form({
      modelId: " alpha， beta, , gamma ",
      primaryType: "text",
    });
    data.append("capabilities", "reasoning");
    await expect(addProviderModelAction({}, data)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    const models = mocks.add.mock.calls[0][2];
    expect(models.map((model: { modelId: string }) => model.modelId)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(
      models.every((model: { capabilities: string[] }) =>
        model.capabilities.includes("reasoning"),
      ),
    ).toBe(true);
  });

  it.each([addProviderModelAction, deleteProviderModelAction])(
    "saves model metadata without a dependent runtime synchronization phase",
    async (action) => {
      await expect(action({}, form())).resolves.toEqual({
        savedAt: expect.any(Number),
      });
    },
  );

  it("reports successful model deletion and refreshes provider views", async () => {
    await expect(deleteProviderModelAction({}, form())).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.invalidate).toHaveBeenCalledWith("acme");
  });

  it.each(["error", "aborted"])(
    "surfaces %s provider completion failures without exposing the API key",
    async (stopReason) => {
      mocks.complete.mockResolvedValue({
        stopReason,
        errorMessage: `failed secret-key ${"x".repeat(300)}`,
      });
      const result = await testProviderModelAction(
        {},
        form({ model: "test-model" }),
      );
      expect(result.error).toContain("[redacted]");
      expect(result.error).not.toContain("secret-key");
      expect(result.error).toHaveLength(240);
    },
  );

  it.each([new Error(""), "failed", null])(
    "uses a safe fallback for completion rejection %s",
    async (error) => {
      mocks.complete.mockRejectedValue(error);
      await expect(
        testProviderModelAction({}, form({ model: "test-model" })),
      ).resolves.toEqual({ error: "Model test failed." });
    },
  );

  it("requires an available provider/model and owner permission before probing credentials", async () => {
    await expect(testProviderModelAction({}, form())).resolves.toEqual({
      error: "Model is required.",
    });
    mocks.user.mockResolvedValue(null);
    await expect(
      testProviderModelAction({}, form({ model: "m" })),
    ).resolves.toEqual({ error: "Not authorized." });
    mocks.user.mockResolvedValue({ id: "owner" });
    mocks.provider.mockResolvedValue(null);
    await expect(
      testProviderModelAction({}, form({ model: "m" })),
    ).resolves.toEqual({ error: "Provider not found." });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("accepts a successful provider probe with a bounded no-retry request", async () => {
    await expect(
      testProviderModelAction({}, form({ model: "m" })),
    ).resolves.toEqual({ savedAt: expect.any(Number) });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { maxTokens: 8, maxRetries: 0, timeoutMs: 10000 },
    );
  });

  it.each(["name", "baseUrl", "apiKey"])(
    "rejects a custom provider missing %s",
    async (field) => {
      await expect(
        createProviderAction({}, form({ [field]: " " })),
      ).resolves.toHaveProperty("error");
      expect(mocks.createProvider).not.toHaveBeenCalled();
    },
  );

  it("creates an authorized custom provider and refreshes settings", async () => {
    await expect(createProviderAction({}, form())).resolves.toEqual({
      savedAt: expect.any(Number),
      providerId: "created",
    });
    expect(mocks.invalidate).toHaveBeenCalledWith("acme");
  });

  it.each([createProviderAction, updateProviderAction])(
    "reports duplicate provider names without internal database detail",
    async (action) => {
      mocks.createProvider.mockRejectedValue(new Error("database detail"));
      mocks.updateProvider.mockRejectedValue(new Error("database detail"));
      await expect(action({}, form())).resolves.toEqual({
        error: "A provider with that name already exists.",
      });
    },
  );

  it("reports catalog refresh warnings after a credential rotation without projecting runtimes", async () => {
    mocks.refresh.mockResolvedValue("catalog offline");
    await expect(updateProviderAction({}, form())).resolves.toEqual({
      savedAt: expect.any(Number),
      warning:
        "Provider updated, but models were not refreshed: catalog offline",
    });
  });

  it("retains the stored API key when refreshing after an endpoint change", async () => {
    await expect(
      updateProviderAction(
        {},
        form({ apiKey: "", baseUrl: "https://new.test" }),
      ),
    ).resolves.toEqual({ savedAt: expect.any(Number) });
    expect(mocks.refresh).toHaveBeenCalledWith(
      "workspace",
      "provider",
      expect.objectContaining({ apiKey: "secret-key" }),
    );
  });

  it("skips credential refresh for a display-name-only edit", async () => {
    await expect(
      updateProviderAction({}, form({ apiKey: "", name: "Renamed" })),
    ).resolves.toEqual({ savedAt: expect.any(Number) });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns owner/provider errors without attempting an update", async () => {
    await expect(
      updateProviderAction({}, form({ providerId: "" })),
    ).resolves.toHaveProperty("error");
    mocks.provider.mockResolvedValue(null);
    await expect(updateProviderAction({}, form())).resolves.toEqual({
      error: "Provider not found.",
    });
    mocks.user.mockResolvedValue(null);
    await expect(createProviderAction({}, form())).resolves.toEqual({
      error: "Not authorized.",
    });
    await deleteProviderAction(form());
    expect(mocks.deleteProvider).not.toHaveBeenCalled();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it("deletes the provider and invalidates views without a runtime synchronization phase", async () => {
    await expect(deleteProviderAction(form())).resolves.toBeUndefined();
    expect(mocks.deleteProvider).toHaveBeenCalledWith(
      "workspace",
      "provider",
      "owner",
    );
    expect(mocks.invalidate).toHaveBeenCalledWith("acme");
  });

  it.each(["default", "title"])(
    "clears %s preference when no provider/model is selected",
    async (preference) => {
      await expect(
        updateWorkspaceModelPreferenceAction(
          {},
          form({ preference, providerId: "", model: "" }),
        ),
      ).resolves.toEqual({ savedAt: expect.any(Number) });
      expect(mocks.workspaceUpdate).toHaveBeenCalledWith({
        where: { id: "workspace" },
        data:
          preference === "default"
            ? { defaultModelProviderId: null, defaultModel: null }
            : { titleModelProviderId: null, titleModel: null },
      });
    },
  );

  it.each([
    ["invalid", "provider", "test-model", "Invalid model preference."],
    ["default", "", "test-model", "Choose an available model."],
    ["title", "provider", "", "Choose an available model."],
    ["default", "provider", "not-in-catalog", "Choose an available model."],
  ])(
    "rejects invalid model preference %s/%s/%s",
    async (preference, providerId, model, error) => {
      await expect(
        updateWorkspaceModelPreferenceAction(
          {},
          form({ preference, providerId, model }),
        ),
      ).resolves.toEqual({ error });
      expect(mocks.workspaceUpdate).not.toHaveBeenCalled();
    },
  );
});
