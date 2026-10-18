// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assistants: [] as Array<{
    id: string;
    workspaceId: string;
    [key: string]: unknown;
  }>,
  providers: [] as Array<{
    id: string;
    workspaceId: string;
    format: string;
    models: string[];
  }>,
  deployments: [] as Array<{
    id: string;
    workspaceId: string;
    server: { slug: string; verifiedAt?: Date | null } | null;
  }>,
  grants: [] as Array<{ assistantId: string; deploymentId: string }>,
  installs: 0,
  published: true,
  template: vi.fn(),
}));
vi.mock("@/lib/market/skills", () => ({
  getAssistantMarketTemplate: state.template,
}));
vi.mock("@/lib/db", () => {
  const client = {
    workspace: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "ws" && where.OR[0].ownerId === "owner"
          ? { id: "ws" }
          : null,
      ),
    },
    modelProvider: {
      findFirst: vi.fn(
        async ({ where }) =>
          state.providers.find(
            (p) => p.id === where.id && p.workspaceId === where.workspaceId,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }) =>
        state.providers.filter(
          (p) =>
            p.workspaceId === where.workspaceId && p.format === where.format,
        ),
      ),
    },
    deployment: {
      findMany: vi.fn(async ({ where }) =>
        state.deployments.filter(
          (d) =>
            d.workspaceId === where.workspaceId &&
            (!where.id || where.id.in.includes(d.id)) &&
            (!where.server ||
              (d.server?.verifiedAt &&
                where.server.is.slug.in.includes(d.server.slug))),
        ),
      ),
    },
    chatAssistant: {
      create: vi.fn(async ({ data }) => {
        const record = {
          ...data,
          id: `assistant-${state.assistants.length + 1}`,
        };
        state.assistants.push(record);
        state.grants.push(
          ...data.mcpGrants.create.map((grant: { deploymentId: string }) => ({
            ...grant,
            assistantId: record.id,
          })),
        );
        return record;
      }),
      findFirst: vi.fn(async ({ where }) =>
        where.workspace?.OR[0].ownerId === "owner"
          ? (state.assistants.find((a) => a.id === where.id) ?? null)
          : null,
      ),
      update: vi.fn(async ({ where, data }) => {
        const record = state.assistants.find((a) => a.id === where.id);
        if (!record) throw new Error("Missing assistant");
        Object.assign(record, data);
        return record;
      }),
      delete: vi.fn(async ({ where }) => {
        state.assistants = state.assistants.filter((a) => a.id !== where.id);
      }),
    },
    chatAssistantMcpGrant: {
      deleteMany: vi.fn(async ({ where }) => {
        state.grants = state.grants.filter(
          (g) => g.assistantId !== where.assistantId,
        );
      }),
      createMany: vi.fn(async ({ data }) => {
        state.grants.push(...data);
      }),
    },
    marketListing: {
      updateMany: vi.fn(async ({ data }) => {
        if (!state.published) return { count: 0 };
        state.installs = Math.max(
          0,
          state.installs +
            (data.installCount.increment ??
              -(data.installCount.decrement ?? 0)),
        );
        return { count: 1 };
      }),
    },
    chatThread: {
      create: vi.fn(async ({ data }) => ({ id: "thread", ...data })),
    },
  };
  return {
    db: {
      ...client,
      $transaction: async (run: (tx: typeof client) => unknown) => {
        const before = {
          assistants: state.assistants.map((a) => ({ ...a })),
          grants: [...state.grants],
          installs: state.installs,
        };
        try {
          return await run(client);
        } catch (error) {
          Object.assign(state, before);
          throw error;
        }
      },
    },
  };
});
import { db } from "@/lib/db";
import {
  createChatAssistant,
  createChatThread,
  deleteChatAssistant,
  getChatPromptGenerationModel,
  installAssistantMarketRelease,
  updateChatAssistant,
} from "@/lib/chat/service";

function template(requireModel = true, requireMcp = true) {
  return {
    releaseId: "release",
    manifest: {
      assistant: {
        name: "Market assistant",
        systemPrompt: "Reviewed policy",
        maxSteps: 7,
        modelRequirement: requireModel
          ? { providerFormat: "openai", model: "model" }
          : undefined,
        mcpRequirements: requireMcp
          ? [{ catalogSlug: "search", name: "Search" }]
          : [],
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.assistants = [];
  state.grants = [];
  state.providers = [
    { id: "provider", workspaceId: "ws", format: "openai", models: ["model"] },
  ];
  state.deployments = [
    {
      id: "mcp",
      workspaceId: "ws",
      server: { slug: "search", verifiedAt: new Date() },
    },
  ];
  state.installs = 0;
  state.published = true;
  state.template.mockResolvedValue(template());
});

describe("assistant market installation resource policy", () => {
  it("selects compatible local resources and creates durable grants and attribution", async () => {
    state.providers.unshift({
      id: "wrong-model",
      workspaceId: "ws",
      format: "openai",
      models: ["different"],
    });
    state.providers.unshift({
      id: "foreign",
      workspaceId: "other",
      format: "openai",
      models: ["model"],
    });
    state.deployments.unshift({
      id: "foreign",
      workspaceId: "other",
      server: { slug: "search", verifiedAt: new Date() },
    });
    const created = await installAssistantMarketRelease("owner", {
      workspaceId: "ws",
      releaseId: "release",
      name: " Custom ",
    });
    expect(created).toMatchObject({
      name: "Custom",
      systemPrompt: "Reviewed policy",
      maxSteps: 7,
      modelProviderId: "provider",
      model: "model",
      marketTemplateReleaseId: "release",
    });
    expect(state.grants).toEqual([
      { assistantId: created.id, deploymentId: "mcp" },
    ]);
    expect(state.installs).toBe(1);
  });

  it.each(
    [
      [],
      [
        {
          id: "no-model",
          workspaceId: "ws",
          format: "openai",
          models: ["other"],
        },
      ],
    ].map((providers) => ({ providers })),
  )("requires an installed compatible provider %#", async ({ providers }) => {
    state.providers = providers;
    await expect(
      installAssistantMarketRelease("owner", {
        workspaceId: "ws",
        releaseId: "release",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.assistants).toEqual([]);
    expect(state.installs).toBe(0);
  });

  it.each([
    {
      id: "provider",
      workspaceId: "other",
      format: "openai",
      models: ["model"],
    },
    {
      id: "provider",
      workspaceId: "ws",
      format: "anthropic",
      models: ["model"],
    },
    { id: "provider", workspaceId: "ws", format: "openai", models: ["other"] },
  ])("rejects an explicitly incompatible provider %#", async (provider) => {
    state.providers = [provider];
    await expect(
      installAssistantMarketRelease("owner", {
        workspaceId: "ws",
        releaseId: "release",
        modelProviderId: "provider",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.assistants).toEqual([]);
  });

  it("permits a deliberate model override on a differently formatted provider with an open catalog", async () => {
    state.providers = [
      { id: "override", workspaceId: "ws", format: "anthropic", models: [] },
    ];
    const assistant = await installAssistantMarketRelease("owner", {
      workspaceId: "ws",
      releaseId: "release",
      modelProviderId: "override",
      model: "chosen",
      systemPrompt: "",
      maxSteps: 3,
      deploymentIds: ["mcp"],
      name: " ",
    });
    expect(assistant).toMatchObject({
      name: "Market assistant",
      model: "chosen",
      modelProviderId: "override",
      systemPrompt: "",
      maxSteps: 3,
    });
  });

  it("accepts model-less templates without fabricating provider bindings", async () => {
    state.template.mockResolvedValue(template(false, false));
    const assistant = await installAssistantMarketRelease("owner", {
      workspaceId: "ws",
      releaseId: "release",
    });
    expect(assistant).toMatchObject({ model: null, modelProviderId: null });
    expect(state.grants).toEqual([]);
    await expect(
      installAssistantMarketRelease("owner", {
        workspaceId: "ws",
        releaseId: "release",
        model: "orphan",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Select a model provider for the selected model",
    });
  });

  it.each([
    null,
    { slug: "search", verifiedAt: null },
    { slug: "different", verifiedAt: new Date() },
  ])(
    "does not satisfy template requirements with an unverified or unrelated deployment %#",
    async (server) => {
      state.deployments = [{ id: "mcp", workspaceId: "ws", server }];
      await expect(
        createChatAssistant("owner", {
          workspaceId: "ws",
          name: "Missing requirements",
          marketTemplateReleaseId: "release",
          deploymentIds: ["mcp"],
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: "Install and select the required MCP servers: Search",
      });
      expect(state.assistants).toEqual([]);
    },
  );

  it("rolls back assistant and grants if marketplace attribution loses publication", async () => {
    state.published = false;
    await expect(
      installAssistantMarketRelease("owner", {
        workspaceId: "ws",
        releaseId: "release",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.assistants).toEqual([]);
    expect(state.grants).toEqual([]);
    expect(state.installs).toBe(0);
  });

  it.each(["create", "install"])(
    "rejects a withdrawn template during %s",
    async (operation) => {
      state.template.mockResolvedValue(null);
      await expect(
        operation === "create"
          ? createChatAssistant("owner", {
              workspaceId: "ws",
              name: "Assistant",
              marketTemplateReleaseId: "release",
            })
          : installAssistantMarketRelease("owner", {
              workspaceId: "ws",
              releaseId: "release",
            }),
      ).rejects.toMatchObject({ status: operation === "create" ? 400 : 404 });
      expect(state.assistants).toEqual([]);
    },
  );
});

describe("assistant mutations preserve ownership and optional settings", () => {
  it("replaces grants, clears an unbound model, and retains omitted settings", async () => {
    const assistant = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Original",
      description: "Keep",
      modelProviderId: "provider",
      model: "model",
      deploymentIds: ["mcp"],
      modelParameters: { temperature: 0.2 },
    });
    await updateChatAssistant("owner", assistant.id, {
      name: "Changed",
      pinned: true,
      systemPrompt: "New policy",
      modelProviderId: null,
      modelParameters: null,
      maxSteps: 9,
      deploymentIds: [],
    });
    expect(state.assistants[0]).toMatchObject({
      name: "Changed",
      description: "Keep",
      pinned: true,
      systemPrompt: "New policy",
      modelProviderId: null,
      model: null,
      maxSteps: 9,
    });
    expect(state.grants).toEqual([]);
    await updateChatAssistant("owner", assistant.id, {
      deploymentIds: ["mcp"],
      modelProviderId: "provider",
      model: "explicit",
      description: null,
      modelParameters: { topP: 0.5 },
    });
    expect(state.assistants[0]).toMatchObject({
      model: "explicit",
      description: null,
      modelParameters: { topP: 0.5 },
    });
    expect(state.grants).toEqual([
      { assistantId: assistant.id, deploymentId: "mcp" },
    ]);
  });

  it.each(["provider", "deployment"])(
    "refuses cross-workspace %s bindings before mutation",
    async (resource) => {
      await createChatAssistant("owner", {
        workspaceId: "ws",
        name: "Original",
      });
      const input =
        resource === "provider"
          ? { modelProviderId: "foreign" }
          : { deploymentIds: ["foreign"] };
      await expect(
        updateChatAssistant("owner", "assistant-1", input),
      ).rejects.toMatchObject({ status: 400 });
      expect(state.assistants[0].name).toBe("Original");
      expect(state.grants).toEqual([]);
    },
  );

  it("deletes template attribution once without affecting standalone assistant counts", async () => {
    const installed = await installAssistantMarketRelease("owner", {
      workspaceId: "ws",
      releaseId: "release",
    });
    Object.assign(state.assistants[0], {
      marketTemplateRelease: { listingId: "listing" },
    });
    await deleteChatAssistant("owner", installed.id);
    expect(state.installs).toBe(0);
    const ordinary = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Ordinary",
    });
    await deleteChatAssistant("owner", ordinary.id);
    expect(state.assistants).toEqual([]);
    expect(state.installs).toBe(0);
  });

  it("authorizes thread creation and prompt model selection", async () => {
    const assistant = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Assistant",
    });
    expect(
      await createChatThread("owner", assistant.id, { title: "Thread" }),
    ).toMatchObject({
      workspaceId: "ws",
      assistantId: assistant.id,
      title: "Thread",
    });
    expect(await createChatThread("owner", assistant.id, {})).toMatchObject({
      title: null,
    });
    await expect(
      createChatThread("other", assistant.id, {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await getChatPromptGenerationModel("owner", {
        workspaceId: "ws",
        modelProviderId: "provider",
      }),
    ).toMatchObject({ id: "provider" });
    await expect(
      getChatPromptGenerationModel("owner", {
        workspaceId: "ws",
        modelProviderId: "foreign",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deleteChatAssistant("other", assistant.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateChatAssistant("other", assistant.id, { name: "Stolen" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createChatAssistant("other", { workspaceId: "ws", name: "Stolen" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(vi.mocked(db.chatThread.create)).toHaveBeenCalledTimes(2);
    expect(state.assistants[0].name).toBe("Assistant");
  });
});
