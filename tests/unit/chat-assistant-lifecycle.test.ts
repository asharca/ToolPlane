// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { ChatAssistantRevisionConfigSchema } from "@/lib/chat/revision-types";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
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
    sourceRef?: string;
    server: { slug: string; verifiedAt?: Date | null } | null;
  }>,
  grants: [] as Array<{
    assistantId: string;
    deploymentId: string;
    allowedToolNames: string[];
  }>,
  revisions: [] as Array<{
    id: string;
    assistantId: string;
    version: number;
    config: unknown;
  }>,
  blockingRun: null as { id: string } | null,
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
        state.deployments
          .filter(
            (d) =>
              d.workspaceId === where.workspaceId &&
              (!where.id || where.id.in.includes(d.id)) &&
              (!where.server ||
                (d.server?.verifiedAt &&
                  where.server.is.slug.in.includes(d.server.slug))),
          )
          .map((deployment) => ({
            ...deployment,
            ...deploymentRecipe(deployment.sourceRef),
          })),
      ),
    },
    chatAssistant: {
      create: vi.fn(async ({ data }) => {
        if (data.currentRevisionVersion)
          throw new Error(
            "An Assistant must be inserted before publishing a revision",
          );
        const record = {
          ...data,
          currentRevisionVersion: data.currentRevisionVersion ?? 0,
          mcpGrants: data.mcpGrants.create,
          modelParameters:
            data.modelParameters === Prisma.DbNull
              ? null
              : data.modelParameters,
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
      findFirst: vi.fn(async ({ where }) => {
        const record =
          where.workspace?.OR[0].ownerId === "owner"
            ? state.assistants.find(
                (a) =>
                  a.id === where.id &&
                  (where.currentRevisionVersion === undefined ||
                    a.currentRevisionVersion === where.currentRevisionVersion),
              )
            : null;
        return record
          ? {
              ...record,
              mcpGrants: state.grants.filter(
                (g) => g.assistantId === record.id,
              ),
              revisions: state.revisions
                .filter((r) => r.assistantId === record.id)
                .sort((a, b) => b.version - a.version),
            }
          : null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const record = state.assistants.find(
          (a) =>
            a.id === where.id &&
            a.currentRevisionVersion === where.currentRevisionVersion,
        );
        if (!record) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const record = state.assistants.find((a) => a.id === where.id);
        if (!record) throw new Error("Missing assistant");
        if (
          data.currentRevisionVersion &&
          !state.revisions.some(
            (revision) =>
              revision.assistantId === record.id &&
              revision.version === data.currentRevisionVersion,
          )
        )
          throw new Error(
            "Cannot publish a revision before its snapshot exists",
          );
        Object.assign(record, data);
        if (data.modelParameters === Prisma.DbNull)
          record.modelParameters = null;
        return {
          ...record,
          mcpGrants: state.grants.filter((g) => g.assistantId === record.id),
        };
      }),
      delete: vi.fn(async ({ where }) => {
        state.assistants = state.assistants.filter((a) => a.id !== where.id);
      }),
    },
    chatAssistantRevision: {
      create: vi.fn(async ({ data }) => {
        const record = {
          ...data,
          id: `revision-${state.revisions.length + 1}`,
        };
        state.revisions.push(record);
        return record;
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
    chatTurn: { findFirst: vi.fn(async () => state.blockingRun) },
    $queryRaw: vi.fn(async () => []),
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
          revisions: [...state.revisions],
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
  copyChatAssistant,
  createChatThread,
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
function deploymentRecipe(sourceRef = "https://mcp.example.com/mcp") {
  return {
    name: "Search",
    source: "remote",
    sourceRef,
    serverId: null,
    installCfg: { transport: "streamable-http", authType: "none", env: {} },
  };
}
function reviewedGrant(deploymentId = "mcp", allowedToolNames = ["search"]) {
  const deployment = state.deployments.find(
    (entry) => entry.id === deploymentId,
  );
  if (!deployment)
    throw new Error(`Missing deployment fixture: ${deploymentId}`);
  return {
    deploymentId,
    allowedToolNames,
    expectedDefinitionChecksum: mcpDefinitionChecksum(
      deploymentRecipe(deployment.sourceRef),
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.assistants = [];
  state.grants = [];
  state.revisions = [];
  state.blockingRun = null;
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

describe("Assistant revision publication, ownership and retained pins", () => {
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
          : {
              mcpGrants: [
                { deploymentId: "foreign", allowedToolNames: ["search"] },
              ],
            };
      await expect(
        updateChatAssistant("owner", "assistant-1", {
          expectedRevision: 1,
          ...input,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(state.assistants[0].name).toBe("Original");
      expect(state.grants).toEqual([]);
    },
  );

  it("publishes immutable snapshots and pins new threads without changing old threads", async () => {
    const assistant = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Assistant",
      systemPrompt: "Original",
      mcpGrants: [reviewedGrant()],
    });
    const oldThread = await createChatThread("owner", assistant.id, {});
    await updateChatAssistant("owner", assistant.id, {
      expectedRevision: 1,
      systemPrompt: "Changed",
      mcpGrants: [],
    });
    const newThread = await createChatThread("owner", assistant.id, {});
    expect(oldThread).toMatchObject({
      assistantRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    expect(newThread).toMatchObject({
      assistantRevisionId: "revision-2",
      legacyRevisionUnresolved: false,
    });
    expect(state.revisions[0]).toMatchObject({
      version: 1,
      config: {
        systemPrompt: "Original",
        mcpGrants: [
          {
            deploymentId: "mcp",
            allowedToolNames: ["search"],
            definitionChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
    });
    expect(state.revisions[1]).toMatchObject({
      version: 2,
      config: { systemPrompt: "Changed", mcpGrants: [] },
    });
    await expect(
      updateChatAssistant("owner", assistant.id, {
        expectedRevision: 1,
        name: "Stale",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.assistants[0].name).toBe("Assistant");
    expect(state.revisions).toHaveLength(2);
  });

  it("refuses new threads without a published revision", async () => {
    state.assistants.push({
      id: "legacy",
      workspaceId: "ws",
      currentRevisionVersion: 0,
    });
    await expect(createChatThread("owner", "legacy", {})).rejects.toMatchObject(
      { status: 409 },
    );
    expect(db.chatThread.create).not.toHaveBeenCalled();
  });

  it("rolls back grant edits and CAS when snapshot publication fails", async () => {
    const assistant = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Original",
    });
    vi.mocked(db.chatAssistantRevision.create).mockRejectedValueOnce(
      new Error("publication failed"),
    );
    await expect(
      updateChatAssistant("owner", assistant.id, {
        expectedRevision: 1,
        name: "Changed",
        mcpGrants: [reviewedGrant()],
      }),
    ).rejects.toThrow("publication failed");
    expect(state.assistants[0]).toMatchObject({
      name: "Original",
      currentRevisionVersion: 1,
    });
    expect(state.grants).toEqual([]);
    expect(state.revisions).toHaveLength(1);
  });

  it("copies configuration into an independent revision without inheriting grants", async () => {
    const source = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Source",
      systemPrompt: "Policy",
      mcpGrants: [reviewedGrant()],
    });
    const copy = await copyChatAssistant("owner", source.id, {
      name: "Copy",
      expectedRevision: 1,
      mcpGrants: [],
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: "Copy",
      currentRevisionVersion: 1,
      systemPrompt: "Policy",
      mcpGrants: [],
    });
    expect(state.revisions[1]).toMatchObject({
      assistantId: copy.id,
      version: 1,
      config: { systemPrompt: "Policy", mcpGrants: [] },
    });
    await updateChatAssistant("owner", source.id, {
      expectedRevision: 1,
      systemPrompt: "Changed",
    });
    expect(state.revisions[1]).toMatchObject({
      config: { systemPrompt: "Policy" },
    });
    await expect(
      copyChatAssistant("owner", source.id, {
        name: "Stale",
        expectedRevision: 1,
        mcpGrants: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rolls back creation when the initial revision cannot be published", async () => {
    vi.mocked(db.chatAssistantRevision.create).mockRejectedValueOnce(
      new Error("publication failed"),
    );
    await expect(
      createChatAssistant("owner", {
        workspaceId: "ws",
        name: "Unpublished",
        mcpGrants: [reviewedGrant()],
      }),
    ).rejects.toThrow("publication failed");
    expect(state.assistants).toEqual([]);
    expect(state.grants).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it("preserves retained MCP pins on unrelated edits and requires fresh review to reauthorize or copy", async () => {
    const source = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Source",
      mcpGrants: [reviewedGrant()],
    });
    const original = ChatAssistantRevisionConfigSchema.parse(
      state.revisions[0]?.config,
    );
    expect(original.mcpGrants[0]?.definitionChecksum).toBe(
      reviewedGrant().expectedDefinitionChecksum,
    );
    const deployment = state.deployments[0];
    if (!deployment) throw new Error("Missing deployment fixture");
    deployment.sourceRef = "https://mcp.example.com/updated";
    await updateChatAssistant("owner", source.id, {
      expectedRevision: 1,
      name: "Edited",
    });
    const edited = ChatAssistantRevisionConfigSchema.parse(
      state.revisions[1]?.config,
    );
    expect(edited.mcpGrants).toEqual(original.mcpGrants);
    await updateChatAssistant("owner", source.id, {
      expectedRevision: 2,
      mcpGrants: [{ deploymentId: "mcp", allowedToolNames: ["search"] }],
    });
    expect(
      ChatAssistantRevisionConfigSchema.parse(state.revisions[2]?.config)
        .mcpGrants,
    ).toEqual(original.mcpGrants);
    await updateChatAssistant("owner", source.id, {
      expectedRevision: 3,
      mcpGrants: [reviewedGrant()],
    });
    const reauthorized = ChatAssistantRevisionConfigSchema.parse(
      state.revisions[3]?.config,
    );
    expect(reauthorized.mcpGrants[0]?.definitionChecksum).toBe(
      reviewedGrant().expectedDefinitionChecksum,
    );
    expect(reauthorized.mcpGrants[0]?.definitionChecksum).not.toBe(
      original.mcpGrants[0]?.definitionChecksum,
    );
    expect(
      ChatAssistantRevisionConfigSchema.parse(state.revisions[0]?.config),
    ).toEqual(original);
    deployment.sourceRef = "https://mcp.example.com/copied";
    const copy = await copyChatAssistant("owner", source.id, {
      name: "Copy",
      expectedRevision: 4,
      mcpGrants: [reviewedGrant()],
    });
    const copied = ChatAssistantRevisionConfigSchema.parse(
      state.revisions[4]?.config,
    );
    expect(state.revisions[4]?.assistantId).toBe(copy.id);
    expect(copied.mcpGrants[0]?.definitionChecksum).toBe(
      reviewedGrant().expectedDefinitionChecksum,
    );
    expect(copied.mcpGrants[0]?.definitionChecksum).not.toBe(
      reauthorized.mcpGrants[0]?.definitionChecksum,
    );
    expect(state.grants).toEqual([
      {
        assistantId: source.id,
        deploymentId: "mcp",
        allowedToolNames: ["search"],
      },
      {
        assistantId: copy.id,
        deploymentId: "mcp",
        allowedToolNames: ["search"],
      },
    ]);
  });

  it.each([
    ["create", "missing"],
    ["create", "stale"],
    ["update", "missing"],
    ["update", "stale"],
    ["copy", "missing"],
    ["copy", "stale"],
  ] as const)(
    "rejects %s with %s MCP discovery approval without publishing or granting",
    async (operation, approval) => {
      const source = await createChatAssistant("owner", {
        workspaceId: "ws",
        name: "Source",
        mcpGrants: [],
      });
      const reviewed = reviewedGrant();
      const deployment = state.deployments[0];
      if (!deployment) throw new Error("Missing deployment fixture");
      deployment.sourceRef = "https://mcp.example.com/changed-after-review";
      const grant =
        approval === "missing"
          ? { deploymentId: "mcp", allowedToolNames: ["search"] }
          : reviewed;
      await expect(
        operation === "create"
          ? createChatAssistant("owner", {
              workspaceId: "ws",
              name: "New",
              mcpGrants: [grant],
            })
          : operation === "copy"
            ? copyChatAssistant("owner", source.id, {
                name: "Copy",
                expectedRevision: 1,
                mcpGrants: [grant],
              })
            : updateChatAssistant("owner", source.id, {
                expectedRevision: 1,
                mcpGrants: [grant],
              }),
      ).rejects.toMatchObject({ status: approval === "missing" ? 400 : 409 });
      expect(state.assistants).toHaveLength(1);
      expect(state.assistants[0]).toMatchObject({
        name: "Source",
        currentRevisionVersion: 1,
      });
      expect(state.revisions).toHaveLength(1);
      expect(state.grants).toEqual([]);
    },
  );

  it("requires fresh recipe approval when changing a retained tool allowlist", async () => {
    const source = await createChatAssistant("owner", {
      workspaceId: "ws",
      name: "Source",
      mcpGrants: [reviewedGrant()],
    });
    await expect(
      updateChatAssistant("owner", source.id, {
        expectedRevision: 1,
        mcpGrants: [{ deploymentId: "mcp", allowedToolNames: ["read"] }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const stale = reviewedGrant("mcp", ["read"]);
    const deployment = state.deployments[0];
    if (!deployment) throw new Error("Missing deployment fixture");
    deployment.sourceRef = "https://mcp.example.com/changed-after-review";
    await expect(
      updateChatAssistant("owner", source.id, {
        expectedRevision: 1,
        mcpGrants: [stale],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.revisions).toHaveLength(1);
    await updateChatAssistant("owner", source.id, {
      expectedRevision: 1,
      mcpGrants: [reviewedGrant("mcp", ["read"])],
    });
    expect(
      ChatAssistantRevisionConfigSchema.parse(state.revisions[1]?.config)
        .mcpGrants,
    ).toEqual([
      {
        deploymentId: "mcp",
        allowedToolNames: ["read"],
        definitionChecksum: reviewedGrant().expectedDefinitionChecksum,
      },
    ]);
    expect(state.grants).toEqual([
      {
        assistantId: source.id,
        deploymentId: "mcp",
        allowedToolNames: ["read"],
      },
    ]);
  });
});
