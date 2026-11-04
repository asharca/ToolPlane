// @vitest-environment node
import { assertDefined } from "../assert-defined";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import * as sandboxRuntime from "@/lib/sandboxes/runtime";
import * as agentRuntime from "@/lib/agents/sandbox-runtime";
import * as ompRuntime from "@/lib/agents/omp-runtime";
import * as piRuntime from "@/lib/agents/pi-runtime";
import {
  AgentExecutionBusyError,
  withAgentExecutionLease,
} from "@/lib/agents/agent-execution-gate";
import {
  cloneAgent,
  createAgent,
  createConfiguredAgent,
  deleteAgent,
  deleteProvider,
  addProviderModels,
  deleteProviderModel,
  updateAgent,
  updateAgentModelSelection,
  setAgentTools,
  updateProvider,
  appendMessage,
  appendConversationTurn,
  createConversation,
  ensureConversationRuntimeSession,
} from "@/lib/agents/mutations";
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  findAgentChannelByInboundToken,
  listAgentChannelConnections,
  updateAgentChannelConnectionCredentials,
} from "@/lib/agents/channel-connections";
import {
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from "@/lib/agents/channel-pairing";
import {
  captureAgentRevisionConfig,
  prepareAgentRevisionMcpDeployments,
  publishAgentRevision,
  resolvePinnedAgent,
} from "@/lib/agents/revisions";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";

// Database revision fixtures exercise persistence/pinning without pretending to
// exercise the sandbox-native publication preflight in this mutation suite.
async function seedPublishedRevision(agentId: string) {
  const owner = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { workspaceId: true },
  });
  await prepareAgentRevisionMcpDeployments(owner.workspaceId, agentId);
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
    const config = await captureAgentRevisionConfig(tx, agentId, {
      kind: "docker",
      image: `toolplane-test@sha256:${"0".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    });
    const revision = await tx.agentRevision.create({
      data: {
        agentId,
        version: agent.currentRevisionVersion + 1,
        config: config as Prisma.InputJsonValue,
      },
    });
    await tx.agent.update({
      where: { id: agentId },
      data: { currentRevisionVersion: revision.version },
    });
    return revision;
  });
}

let workspaceId = "";
let userId = "";
let deploymentId = "";
let providerId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `agents-m-${Date.now()}@test.dev`, passwordHash: "x" },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: {
      slug: `agents-m-${Date.now()}`,
      name: "M",
      ownerId: userId,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = ws.id;
  const server = await db.server.create({
    data: { slug: `srv-${Date.now()}`, name: "Srv" },
  });
  const dep = await db.deployment.create({
    data: {
      workspaceId,
      serverId: server.id,
      source: "remote",
      sourceRef: "https://mcp.example.test/mcp",
      installCfg: { transport: "streamable-http", authType: "none" },
    },
  });
  deploymentId = dep.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "P",
      format: "openai",
      baseUrl: "https://x/v1",
      apiKey: "k",
      models: ["model-1", "gpt-4.1", "gpt-x"],
    },
  });
  providerId = provider.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

beforeEach(() => {
  // Only the external Docker artifact boundary is stubbed; DB behavior is real.
  vi.spyOn(piRuntime, "preparePiRuntime").mockResolvedValue({
    path: "/fixture/pi-sdk.archive",
    sha256: "a".repeat(64),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function createDockerSandbox(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: label, source: "sandbox", status: "stopped" },
  });
  return db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: label,
      slug: `test-sandbox-${suffix}`,
      kind: "docker",
      network: "isolated",
    },
  });
}

describe("agents mutations", () => {
  it("creates an enabled Agent whose first conversation pins the selected configuration", async () => {
    // External Docker boundaries only; persistence, authorization, and pinning are real.
    vi.spyOn(sandboxRuntime, "resolveDockerImageDigest").mockResolvedValue(
      `fixture@sha256:${"a".repeat(64)}`,
    );
    vi.spyOn(agentRuntime, "preflightPiSdkCapabilities").mockResolvedValue({
      commands: [],
      tools: [],
      skills: [],
      prompts: [],
    });
    const agent = await createConfiguredAgent(
      workspaceId,
      {
        name: "Ready on creation",
        providerId,
        model: "model-1",
        systemPrompt: "Selected instructions",
        maxSteps: 8,
      },
      { deploymentIds: [], installedSkillIds: [], toolkitIds: [] },
      { runtime: "pi-sdk", enable: true },
    );
    const current = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(current.currentRevisionVersion).toBe(1);
    const conversation = await createConversation(workspaceId, agent.id);
    if (!conversation)
      throw new Error("Created Agent must accept a conversation");
    const pinned = await resolvePinnedAgent(
      current,
      conversation.agentRevisionId,
    );
    expect(pinned).toMatchObject({
      providerId,
      model: "model-1",
      systemPrompt: "Selected instructions",
      maxSteps: 8,
    });
  });

  it.each([
    { runtime: "pi-sdk", failure: "PI_SDK_ARTIFACT_PREPARE_FAILED" },
    { runtime: "pi-sdk", failure: "PI_CAPABILITY_CONFLICT" },
    { runtime: "omp", failure: "OMP_ARTIFACT_DOWNLOAD_FAILED" },
  ] as const)(
    "leaves no $runtime creation records when $failure occurs",
    async ({ runtime, failure }) => {
      vi.spyOn(sandboxRuntime, "resolveDockerImageDigest").mockResolvedValue(
        `fixture@sha256:${"a".repeat(64)}`,
      );
      vi.spyOn(agentRuntime, "preflightPiSdkCapabilities").mockRejectedValue(
        new Error("PI_CAPABILITY_CONFLICT"),
      );
      vi.spyOn(ompRuntime, "prepareOmpRuntime").mockRejectedValue(
        new Error("OMP_ARTIFACT_DOWNLOAD_FAILED"),
      );
      if (failure === "PI_SDK_ARTIFACT_PREPARE_FAILED") {
        vi.mocked(piRuntime.preparePiRuntime).mockRejectedValue(
          new Error(failure),
        );
      }
      const before = {
        agents: await db.agent.count({ where: { workspaceId } }),
        sandboxes: await db.sandbox.count({ where: { workspaceId } }),
        deployments: await db.deployment.count({ where: { workspaceId } }),
      };
      await expect(
        createConfiguredAgent(
          workspaceId,
          {
            name: "Rejected creation",
            providerId,
            model: "model-1",
            systemPrompt: null,
            maxSteps: 8,
          },
          { deploymentIds: [], installedSkillIds: [], toolkitIds: [] },
          { runtime, enable: true },
        ),
      ).rejects.toThrow(failure);
      expect({
        agents: await db.agent.count({ where: { workspaceId } }),
        sandboxes: await db.sandbox.count({ where: { workspaceId } }),
        deployments: await db.deployment.count({ where: { workspaceId } }),
      }).toEqual(before);
    },
  );

  it("preserves the draft and creates no revision when Pi artifact publication preparation fails", async () => {
    const agent = await createAgent(
      workspaceId,
      "Pi publication preparation failure",
    );
    const config = await captureAgentRevisionConfig(db, agent.id, {
      kind: "docker",
      image: `toolplane-test@sha256:${"0".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    });
    const before = {
      agents: await db.agent.count({ where: { workspaceId } }),
      sandboxes: await db.sandbox.count({ where: { workspaceId } }),
      deployments: await db.deployment.count({ where: { workspaceId } }),
    };
    vi.mocked(piRuntime.preparePiRuntime).mockRejectedValue(
      new Error("PI_SDK_ARTIFACT_PREPARE_FAILED"),
    );
    await expect(
      publishAgentRevision(workspaceId, agent.id, {
        expectedRevisionId: null,
        config,
      }),
    ).rejects.toThrow("PI_SDK_ARTIFACT_PREPARE_FAILED");
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agent.id } }))
        .currentRevisionVersion,
    ).toBe(0);
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      0,
    );
    expect({
      agents: await db.agent.count({ where: { workspaceId } }),
      sandboxes: await db.sandbox.count({ where: { workspaceId } }),
      deployments: await db.deployment.count({ where: { workspaceId } }),
    }).toEqual(before);
  });

  it("rejects enabling a new Agent with another workspace's model provider", async () => {
    const foreign = await db.workspace.create({
      data: {
        name: "Foreign creation",
        slug: `foreign-create-${Date.now()}`,
        ownerId: userId,
      },
    });
    try {
      await expect(
        createConfiguredAgent(
          foreign.id,
          {
            name: "Unauthorized creation",
            providerId,
            model: "model-1",
            systemPrompt: null,
            maxSteps: 8,
          },
          { deploymentIds: [], installedSkillIds: [], toolkitIds: [] },
          { runtime: "pi-sdk", enable: true },
        ),
      ).rejects.toThrow("Unknown model provider");
      expect(await db.agent.count({ where: { workspaceId: foreign.id } })).toBe(
        0,
      );
      expect(
        await db.sandbox.count({ where: { workspaceId: foreign.id } }),
      ).toBe(0);
    } finally {
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it("creates native drafts with lazy sandbox records and rejects legacy creation", async () => {
    const agent = await createAgent(workspaceId, "Native default draft");
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      include: {
        sandboxes: { include: { sandbox: { include: { deployment: true } } } },
      },
    });
    expect(stored.runtimeKind).toBe("pi-sdk");
    expect(stored.currentRevisionVersion).toBe(0);
    expect(stored.sandboxes).toHaveLength(1);
    expect(stored.sandboxes[0].sandbox.deployment.status).toBe("stopped");
    await expect(createConversation(workspaceId, agent.id)).rejects.toThrow(
      "AGENT_REVISION_UNRESOLVED",
    );
    for (const runtime of ["pi", "claude-code", "dsh"] as const) {
      await expect(
        createAgent(workspaceId, `Retired ${runtime}`, { runtime }),
      ).rejects.toThrow("Only native Pi");
    }
  });

  it("copies historical configuration into a fresh native draft with no authority", async () => {
    const source = await db.agent.create({
      data: {
        workspaceId,
        name: "Historical clone source",
        slug: `history-copy-${Date.now()}`,
        runtimeKind: "pi",
        retiredAt: new Date(),
        systemPrompt: "Convertible instructions",
        a2aInboundEnabled: true,
        a2aOutboundEnabled: true,
        servers: { create: { deploymentId } },
      },
    });
    const history = await db.conversation.create({
      data: {
        agentId: source.id,
        messages: {
          create: {
            role: "user",
            parts: [{ type: "text", text: "Historical task" }],
          },
        },
      },
    });
    const cloned = assertDefined(
      await cloneAgent(workspaceId, source.id, undefined, {
        copyConversations: true,
      }),
    );
    const target = await db.agent.findUniqueOrThrow({
      where: { id: cloned.id },
      include: {
        servers: true,
        skills: true,
        toolkits: true,
        piPackages: true,
        subAgents: true,
        sandboxes: true,
        conversations: { include: { messages: true } },
      },
    });
    expect(target).toMatchObject({
      runtimeKind: "pi-sdk",
      retiredAt: null,
      currentRevisionVersion: 0,
      systemPrompt: "Convertible instructions",
      a2aInboundEnabled: false,
      a2aOutboundEnabled: false,
    });
    for (const grants of [
      target.servers,
      target.skills,
      target.toolkits,
      target.piPackages,
      target.subAgents,
    ])
      expect(grants).toHaveLength(0);
    expect(target.sandboxes).toHaveLength(1);
    expect(target.conversations[0]).toMatchObject({
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
    });
    expect(target.conversations[0].messages[0].parts).toEqual([
      { type: "text", text: "Historical task" },
    ]);
    expect(
      await db.conversation.findUnique({ where: { id: history.id } }),
    ).not.toBeNull();
    await expect(
      cloneAgent(workspaceId, source.id, undefined, { copyMcp: true }),
    ).rejects.toThrow("fresh capability authorization");
    await expect(
      updateAgent(workspaceId, source.id, {
        name: source.name,
        systemPrompt: null,
        providerId: null,
        model: null,
        maxSteps: 8,
      }),
    ).rejects.toThrow("read-only");
  });

  it("pins published defaults without rebinding existing or unresolved conversations", async () => {
    const agent = await createAgent(workspaceId, "Pinned conversation agent");
    const legacy = await db.conversation.create({
      data: { agentId: agent.id },
    });
    const first = await seedPublishedRevision(agent.id);
    const conversation = assertDefined(
      await createConversation(workspaceId, agent.id),
    );
    expect(conversation).toMatchObject({
      agentRevisionId: first.id,
      legacyRevisionUnresolved: false,
    });
    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: "Draft changed",
      providerId: null,
      model: null,
      maxSteps: 8,
    });
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agent.id } }))
        .currentRevisionVersion,
    ).toBe(first.version);
    const second = await seedPublishedRevision(agent.id);
    expect(await createConversation(workspaceId, agent.id)).toMatchObject({
      agentRevisionId: second.id,
      legacyRevisionUnresolved: false,
    });
    expect(
      await db.conversation.findUnique({ where: { id: conversation.id } }),
    ).toMatchObject({ agentRevisionId: first.id });
    expect(
      await db.conversation.findUnique({ where: { id: legacy.id } }),
    ).toMatchObject({ agentRevisionId: null, legacyRevisionUnresolved: true });
  });

  it("saves configuration during execution without rebinding its conversation or permitting deletion", async () => {
    const agent = await createAgent(workspaceId, "Running settings agent");
    const published = await seedPublishedRevision(agent.id);
    const conversation = assertDefined(
      await createConversation(workspaceId, agent.id),
    );
    await withAgentExecutionLease(
      { agentId: agent.id, sessionId: conversation.id },
      async () => {
        await updateAgent(workspaceId, agent.id, {
          name: agent.name,
          systemPrompt: "Next revision instructions",
          providerId: null,
          model: null,
          maxSteps: 8,
        });
        await setAgentTools(workspaceId, agent.id, {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
        });
        await updateAgent(`${workspaceId}-outside`, agent.id, {
          name: "Unauthorized edit",
          systemPrompt: null,
          providerId: null,
          model: null,
          maxSteps: 1,
        });
        expect(
          await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
        ).toMatchObject({
          name: agent.name,
          systemPrompt: "Next revision instructions",
          currentRevisionVersion: published.version,
        });
        expect(
          await db.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
          }),
        ).toMatchObject({ agentRevisionId: published.id });
        expect(
          await db.agentRevision.findUniqueOrThrow({
            where: { id: published.id },
          }),
        ).toMatchObject({ config: published.config });
        await expect(deleteAgent(workspaceId, agent.id)).rejects.toBeInstanceOf(
          AgentExecutionBusyError,
        );
      },
    );
  });

  it.each(["config", "model"] as const)(
    "keeps immutable provider pins across unapplied native default changes through %s and rejects actual provider deletion",
    async (editPath) => {
      const prior = await db.modelProvider.create({
        data: {
          workspaceId,
          name: `Prior pin ${editPath} ${Date.now()}`,
          format: "openai",
          baseUrl: "https://models.example.test/v1",
          apiKey: "fixture",
          models: ["prior-model"],
        },
      });
      const next = await db.modelProvider.create({
        data: {
          workspaceId,
          name: `Next pin ${editPath} ${Date.now()}`,
          format: "openai",
          baseUrl: "https://models.example.test/v1",
          apiKey: "fixture",
          models: ["next-model"],
        },
      });
      const agent = await createConfiguredAgent(
        workspaceId,
        {
          name: `Provider pin ${editPath}`,
          systemPrompt: "Published instructions",
          providerId: prior.id,
          model: "prior-model",
          maxSteps: 8,
        },
        {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
        },
        { runtime: "pi-sdk" },
      );
      const published = await seedPublishedRevision(agent.id);
      const conversation = assertDefined(
        await createConversation(workspaceId, agent.id),
      );
      if (editPath === "config") {
        await updateAgent(workspaceId, agent.id, {
          name: agent.name,
          systemPrompt: "Unpublished draft",
          providerId: next.id,
          model: "next-model",
          maxSteps: 8,
        });
      } else {
        await updateAgentModelSelection(
          workspaceId,
          agent.id,
          next.id,
          "next-model",
        );
      }
      const changed = await db.agent.findUniqueOrThrow({
        where: { id: agent.id },
      });
      expect(changed.providerId).toBe(next.id);
      expect(changed.currentRevisionVersion).toBe(published.version);
      await expect(
        resolvePinnedAgent(changed, conversation.agentRevisionId),
      ).resolves.toMatchObject({
        providerId: prior.id,
        provider: { id: prior.id },
        model: "prior-model",
        systemPrompt: "Published instructions",
      });
      await updateAgentModelSelection(workspaceId, agent.id, null, null);
      await expect(
        resolvePinnedAgent(changed, conversation.agentRevisionId),
      ).resolves.toMatchObject({
        providerId: prior.id,
        provider: { id: prior.id },
        model: "prior-model",
      });
      await deleteProvider(workspaceId, prior.id, userId);
      await expect(
        resolvePinnedAgent(changed, conversation.agentRevisionId),
      ).rejects.toThrow("AGENT_PROVIDER_REVOKED");
    },
  );

  it("rejects a model that is no longer available from its provider", async () => {
    const before = await db.agent.count({ where: { workspaceId } });

    await expect(
      createConfiguredAgent(
        workspaceId,
        {
          name: `Stale model ${Date.now()}`,
          systemPrompt: null,
          providerId,
          model: "stale-model",
          maxSteps: 8,
        },
        {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
        },
        { runtime: "pi-sdk" },
      ),
    ).rejects.toThrow("Unknown or unavailable model: stale-model");

    await expect(db.agent.count({ where: { workspaceId } })).resolves.toBe(
      before,
    );
  });

  it("rejects an unavailable model from both Agent edit paths", async () => {
    const agent = await createAgent(
      workspaceId,
      `Edit stale model ${Date.now()}`,
      { runtime: "pi-sdk" },
    );
    const config = {
      name: agent.name,
      systemPrompt: null,
      providerId,
      model: "stale-model",
      maxSteps: 8,
    };

    await expect(updateAgent(workspaceId, agent.id, config)).rejects.toThrow(
      "Unknown or unavailable model: stale-model",
    );
    await expect(
      updateAgentModelSelection(
        workspaceId,
        agent.id,
        providerId,
        config.model,
      ),
    ).rejects.toThrow("Unknown or unavailable model: stale-model");
    await expect(
      db.agent.findUnique({ where: { id: agent.id } }),
    ).resolves.toMatchObject({
      providerId: null,
      model: null,
    });

    await deleteAgent(workspaceId, agent.id);
  });

  it("deletes an agent-owned sandbox with its agent", async () => {
    const agent = await createAgent(
      workspaceId,
      `Disposable sandbox ${Date.now()}`,
      { runtime: "pi-sdk" },
    );
    const sandbox = await db.sandbox.findFirstOrThrow({
      where: { workspaceId, agentLinks: { some: { agentId: agent.id } } },
      select: { id: true, deploymentId: true },
    });

    await deleteAgent(workspaceId, agent.id);

    await expect(
      db.sandbox.findUnique({ where: { id: sandbox.id } }),
    ).resolves.toBeNull();
    await expect(
      db.deployment.findUnique({ where: { id: sandbox.deploymentId } }),
    ).resolves.toBeNull();
  });

  it("shares external sandboxes across Agents and narrows pinned access to the live attachment", async () => {
    const owner = await createAgent(workspaceId, "External owner", {
      runtime: "pi-sdk",
    });
    const peer = await createAgent(workspaceId, "External peer", {
      runtime: "pi-sdk",
    });
    const ownSandbox = await db.agentSandbox.findMany({
      where: { agentId: owner.id },
    });
    const peerOwn = await db.agentSandbox.findFirstOrThrow({
      where: { agentId: peer.id },
    });
    const shared = await createDockerSandbox("Shared external");
    const archived = await createDockerSandbox("Archived external");
    const sessionCopy = await createDockerSandbox("Session copy");
    await db.sandbox.update({
      where: { id: archived.id },
      data: { config: { readOnly: true } },
    });
    const none = { deploymentIds: [], installedSkillIds: [], toolkitIds: [] };
    try {
      await setAgentTools(workspaceId, owner.id, {
        ...none,
        externalSandboxes: [{ sandboxId: shared.id, access: "full" }],
      });
      await setAgentTools(workspaceId, peer.id, {
        ...none,
        externalSandboxes: [{ sandboxId: shared.id, access: "read" }],
      });
      // Another Agent's own sandbox and read-only rows are never attachable.
      for (const sandboxId of [peerOwn.sandboxId, archived.id])
        await expect(
          setAgentTools(workspaceId, owner.id, {
            ...none,
            externalSandboxes: [{ sandboxId, access: "read" }],
          }),
        ).rejects.toThrow("Only SSH, connector or standalone Docker");
      // Omitting the selection keeps attachments; the own sandbox never moves.
      await setAgentTools(workspaceId, owner.id, none);
      await expect(
        db.agentExternalSandbox.findMany({
          where: { sandboxId: shared.id },
          orderBy: { access: "asc" },
          select: { agentId: true, access: true },
        }),
      ).resolves.toEqual([
        { agentId: owner.id, access: "full" },
        { agentId: peer.id, access: "read" },
      ]);
      await expect(
        db.agentSandbox.findMany({ where: { agentId: owner.id } }),
      ).resolves.toEqual(ownSandbox);

      await updateAgent(workspaceId, owner.id, {
        name: "External owner",
        systemPrompt: null,
        providerId,
        model: "gpt-x",
        maxSteps: 5,
      });
      const revision = await seedPublishedRevision(owner.id);
      expect(
        AgentRevisionConfigSchema.parse(revision.config).externalSandboxes,
      ).toEqual([{ sandboxId: shared.id, access: "full" }]);
      const conversation = await db.conversation.create({
        data: {
          agentId: owner.id,
          agentRevisionId: revision.id,
          legacyRevisionUnresolved: false,
          sandboxId: sessionCopy.id,
        },
      });
      const token = {
        workspaceId,
        agentId: owner.id,
        agentRevisionId: revision.id,
        sandboxId: sessionCopy.id,
        conversationId: conversation.id,
        providerId,
        deploymentIds: [],
        externalSandboxIds: [shared.id],
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const grantFor = async () =>
        (await resolveAgentRuntimeGrant(token))?.externalSandboxTools;
      await expect(grantFor()).resolves.toEqual({
        [shared.id]: expect.arrayContaining(["shell_exec", "write_file"]),
      });
      await setAgentTools(workspaceId, owner.id, {
        ...none,
        externalSandboxes: [{ sandboxId: shared.id, access: "read" }],
      });
      await expect(grantFor()).resolves.toEqual({
        [shared.id]: ["sandbox_info", "list_dir", "read_file", "download_file"],
      });
      // Detaching revokes only that sandbox, not the session grant.
      await setAgentTools(workspaceId, owner.id, {
        ...none,
        externalSandboxes: [],
      });
      await expect(grantFor()).resolves.toEqual({});
    } finally {
      await deleteAgent(workspaceId, owner.id);
      await deleteAgent(workspaceId, peer.id);
      await db.deployment.deleteMany({
        where: {
          id: {
            in: [
              shared.deploymentId,
              archived.deploymentId,
              sessionCopy.deploymentId,
            ],
          },
        },
      });
    }
  });

  it("updates config and replaces the attached tools", async () => {
    const a = await createAgent(workspaceId, "Cfg", { runtime: "pi-sdk" });
    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        installCfg: {
          transport: "streamable-http",
          authType: "none",
          toolCatalog: [{ name: "read" }, { name: "write" }],
        },
      },
    });
    await updateAgent(workspaceId, a.id, {
      name: "Cfg2",
      systemPrompt: "sp",
      providerId,
      model: "gpt-x",
      maxSteps: 5,
    });
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId],
      installedSkillIds: [],
      toolkitIds: [],
    });
    const reread = await db.agent.findUnique({
      where: { id: a.id },
      include: { servers: true },
    });
    expect(reread?.name).toBe("Cfg2");
    expect(reread?.model).toBe("gpt-x");
    expect(reread?.servers).toHaveLength(1);
    expect(reread?.servers[0]?.allowedToolNames).toEqual(["read", "write"]);
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId],
      installedSkillIds: [],
      toolkitIds: [],
    });
    const retainedGrant = await db.agentServer.findUniqueOrThrow({
      where: { agentId_deploymentId: { agentId: a.id, deploymentId } },
    });
    expect(retainedGrant.allowedToolNames).toEqual(["read", "write"]);

    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [],
      installedSkillIds: [],
      toolkitIds: [],
    });
    const after = await db.agent.findUnique({
      where: { id: a.id },
      include: { servers: true },
    });
    expect(after?.servers).toHaveLength(0);
  });

  it("rejects cross-workspace model writes and removal of an in-use model", async () => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Protected model provider ${Date.now()}`,
        format: "openai",
        baseUrl: "https://protected.test/v1",
        apiKey: "k",
      },
    });
    const model = {
      modelId: "protected-chat-v1",
      name: "Protected Chat",
      group: "Protected",
      primaryType: "text" as const,
      capabilities: ["reasoning" as const],
      inputModalities: [],
      contextWindow: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    };
    await expect(
      addProviderModels("foreign-workspace", provider.id, [model]),
    ).rejects.toThrow("Provider not found.");
    await addProviderModels(workspaceId, provider.id, [model]);
    const agent = await createAgent(workspaceId, "Protected model agent", {
      runtime: "pi-sdk",
    });
    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: null,
      providerId: provider.id,
      model: model.modelId,
      maxSteps: 8,
    });

    await expect(
      deleteProviderModel(workspaceId, provider.id, model.modelId),
    ).rejects.toThrow("This model is in use and cannot be removed.");

    await deleteAgent(workspaceId, agent.id);
    await deleteProvider(workspaceId, provider.id);
  });

  it("clears the model from linked agents when deleting a provider", async () => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Disposable provider ${Date.now()}`,
        format: "openai",
        baseUrl: "https://disposable.test/v1",
        apiKey: "k",
        models: ["gpt-disposable"],
      },
    });
    const agent = await createAgent(workspaceId, "Disposable provider agent", {
      runtime: "pi-sdk",
    });
    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: null,
      providerId: provider.id,
      model: "gpt-disposable",
      maxSteps: 8,
    });

    await deleteProvider(workspaceId, provider.id);

    const [deletedProvider, rereadAgent] = await Promise.all([
      db.modelProvider.findUnique({ where: { id: provider.id } }),
      db.agent.findUnique({ where: { id: agent.id } }),
    ]);
    expect(deletedProvider).toBeNull();
    expect(rereadAgent?.providerId).toBeNull();
    expect(rereadAgent?.model).toBeNull();

    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: null,
      providerId: provider.id,
      model: "stale-model",
      maxSteps: 8,
    });
    const afterStaleSave = await db.agent.findUnique({
      where: { id: agent.id },
    });
    expect(afterStaleSave?.providerId).toBeNull();
    expect(afterStaleSave?.model).toBeNull();

    await deleteAgent(workspaceId, agent.id);
  });

  it("updates providers within the workspace and keeps the API key when omitted", async () => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Update Me ${Date.now()}`,
        format: "openai",
        baseUrl: "https://old.example.test/v1",
        apiKey: "keep-me",
      },
    });

    await updateProvider(workspaceId, provider.id, {
      name: `${provider.name} Renamed`,
      format: "anthropic",
      baseUrl: "https://new.example.test/v1",
    });

    const reread = await db.modelProvider.findUnique({
      where: { id: provider.id },
    });
    expect(reread).toMatchObject({
      name: `${provider.name} Renamed`,
      format: "anthropic",
      baseUrl: "https://new.example.test/v1",
      apiKey: "keep-me",
    });
    await db.modelProvider.delete({ where: { id: provider.id } });
  });

  it("does not update providers from another workspace", async () => {
    const other = await db.workspace.create({
      data: {
        slug: `provider-other-${Date.now()}`,
        name: "Provider Other",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: other.id,
        name: `Foreign Provider ${Date.now()}`,
        format: "openai",
        baseUrl: "https://foreign.example.test/v1",
        apiKey: "foreign-key",
      },
    });

    await updateProvider(workspaceId, provider.id, {
      name: "Should Not Change",
      format: "anthropic",
      baseUrl: "https://changed.example.test/v1",
      apiKey: "changed-key",
    });

    const reread = await db.modelProvider.findUnique({
      where: { id: provider.id },
    });
    expect(reread).toMatchObject({
      name: provider.name,
      format: "openai",
      baseUrl: "https://foreign.example.test/v1",
      apiKey: "foreign-key",
    });
    await db.workspace.delete({ where: { id: other.id } });
  });

  it("creates a conversation and appends messages", async () => {
    const a = await createAgent(workspaceId, "Chat", { runtime: "pi-sdk" });
    await seedPublishedRevision(a.id);
    const conv = await createConversation(workspaceId, a.id);
    await appendMessage(assertDefined(conv).id, "user", [
      { type: "text", text: "hi" },
    ]);
    const msgs = await db.message.findMany({
      where: { conversationId: assertDefined(conv).id },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(
      await db.conversation.findUnique({
        where: { id: assertDefined(conv).id },
      }),
    ).toMatchObject({
      title: "hi",
    });
    await appendMessage(assertDefined(conv).id, "user", [
      { type: "text", text: "a later question" },
    ]);
    expect(
      await db.conversation.findUnique({
        where: { id: assertDefined(conv).id },
      }),
    ).toMatchObject({
      title: "hi",
    });
    expect(conv).toMatchObject({
      runtimeSessionId: assertDefined(conv).id,
      runtimeSessionKey: `agent:${a.id}:console:${assertDefined(conv).id}`,
    });

    const legacy = await createConversation(workspaceId, a.id);
    await db.message.create({
      data: {
        conversationId: assertDefined(legacy).id,
        role: "user",
        parts: [{ type: "text", text: "legacy turn" }],
      },
    });
    await appendMessage(assertDefined(legacy).id, "user", [
      { type: "text", text: "new turn" },
    ]);
    expect(
      await db.conversation.findUnique({
        where: { id: assertDefined(legacy).id },
      }),
    ).toMatchObject({
      title: null,
    });

    const messagingConversation = await createConversation(
      workspaceId,
      a.id,
      "msg:slack:dm:U123",
      {
        runtimeSessionKey: "msg:slack:dm:U123",
      },
    );
    expect(messagingConversation).toMatchObject({
      runtimeSessionId: assertDefined(messagingConversation).id,
      runtimeSessionKey: "msg:slack:dm:U123",
    });
  });

  it("persists a generated user/assistant turn atomically and in order", async () => {
    const agent = await createAgent(workspaceId, "Atomic turn", {
      runtime: "pi-sdk",
    });
    await seedPublishedRevision(agent.id);
    const conversation = await createConversation(workspaceId, agent.id);
    await appendConversationTurn(
      assertDefined(conversation).id,
      [{ type: "text", text: "Question" }],
      [{ type: "text", text: "Answer" }],
    );

    const messages = await db.message.findMany({
      where: { conversationId: assertDefined(conversation).id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);

    const rollbackConversation = await createConversation(
      workspaceId,
      agent.id,
    );
    await expect(
      appendConversationTurn(
        assertDefined(rollbackConversation).id,
        [{ type: "text", text: "Must roll back" }],
        undefined as unknown as Prisma.InputJsonValue,
      ),
    ).rejects.toThrow();
    await expect(
      db.message.count({
        where: { conversationId: assertDefined(rollbackConversation).id },
      }),
    ).resolves.toBe(0);
  });

  it("atomically derives a title when the first user messages race", async () => {
    const agent = await createAgent(workspaceId, "Concurrent title", {
      runtime: "pi-sdk",
    });
    await seedPublishedRevision(agent.id);
    const conversation = await createConversation(workspaceId, agent.id);

    await Promise.all([
      appendMessage(assertDefined(conversation).id, "user", [
        { type: "text", text: "First candidate" },
      ]),
      appendMessage(assertDefined(conversation).id, "user", [
        { type: "text", text: "Second candidate" },
      ]),
    ]);

    const reread = await db.conversation.findUnique({
      where: { id: assertDefined(conversation).id },
    });
    expect(["First candidate", "Second candidate"]).toContain(reread?.title);
    expect(
      await db.message.count({
        where: { conversationId: assertDefined(conversation).id },
      }),
    ).toBe(2);
  });

  it("initializes legacy runtime session aliases once without replacing them", async () => {
    const agent = await createAgent(workspaceId, "Legacy runtime chat", {
      runtime: "pi-sdk",
    });
    const legacy = await db.conversation.create({
      data: { agentId: agent.id },
    });

    const initialized = await ensureConversationRuntimeSession(
      workspaceId,
      agent.id,
      legacy.id,
      { runtimeSessionKey: "msg:slack:dm:U123" },
    );
    expect(initialized).toEqual({
      runtimeSessionId: legacy.id,
      runtimeSessionKey: "msg:slack:dm:U123",
    });

    const retained = await ensureConversationRuntimeSession(
      workspaceId,
      agent.id,
      legacy.id,
      {
        runtimeSessionId: "different-session",
        runtimeSessionKey: "different-key",
      },
    );
    expect(retained).toEqual(initialized);
    expect(
      await db.conversation.findUnique({ where: { id: legacy.id } }),
    ).toMatchObject({
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
    });
  });

  it("drops cross-workspace tool ids in setAgentTools", async () => {
    const other = await db.workspace.create({
      data: {
        slug: `m-other-${Date.now()}`,
        name: "O",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    const fserver = await db.server.create({
      data: { slug: `fsrv-${Date.now()}`, name: "F" },
    });
    const fdep = await db.deployment.create({
      data: { workspaceId: other.id, serverId: fserver.id },
    });
    const a = await createAgent(workspaceId, "Scope", { runtime: "pi-sdk" });
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId, fdep.id],
      installedSkillIds: [],
      toolkitIds: [],
    });
    const reread = await db.agent.findUnique({
      where: { id: a.id },
      include: { servers: true },
    });
    expect(reread?.servers.map((s) => s.deploymentId)).toEqual([deploymentId]);
    await db.workspace.delete({ where: { id: other.id } });
  });

  it("nulls a cross-workspace providerId in updateAgent", async () => {
    const other = await db.workspace.create({
      data: {
        slug: `m-o2-${Date.now()}`,
        name: "O2",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    const fprov = await db.modelProvider.create({
      data: {
        workspaceId: other.id,
        name: "FP",
        format: "openai",
        baseUrl: "https://x/v1",
        apiKey: "k",
      },
    });
    const a = await createAgent(workspaceId, "ProvScope", {
      runtime: "pi-sdk",
    });
    await updateAgent(workspaceId, a.id, {
      name: "ProvScope",
      systemPrompt: null,
      providerId: fprov.id,
      model: null,
      maxSteps: 8,
    });
    const reread = await db.agent.findUnique({ where: { id: a.id } });
    expect(reread?.providerId).toBeNull();

    const linked = await createAgent(workspaceId, "Native provider scope", {
      runtime: "pi-sdk",
    });
    await updateAgent(workspaceId, linked.id, {
      name: linked.name,
      systemPrompt: null,
      providerId,
      model: null,
      maxSteps: 8,
    });
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: linked.id } }),
    ).resolves.toMatchObject({ providerId });
    await updateAgent(workspaceId, linked.id, {
      name: linked.name,
      systemPrompt: null,
      providerId: fprov.id,
      model: null,
      maxSteps: 8,
    });
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: linked.id } }),
    ).resolves.toMatchObject({ providerId: null });
    await db.workspace.delete({ where: { id: other.id } });
  });

  it("refuses to create, clone, or delete an agent outside the workspace", async () => {
    const other = await db.workspace.create({
      data: {
        slug: `m-o3-${Date.now()}`,
        name: "O3",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    const fagent = await db.agent.create({
      data: {
        workspaceId: other.id,
        name: "FA",
        slug: "fa",
        runtimeKind: "pi",
      },
    });
    const conv = await createConversation(workspaceId, fagent.id);
    expect(conv).toBeNull();
    expect(await cloneAgent(workspaceId, fagent.id)).toBeNull();
    await deleteAgent(workspaceId, fagent.id);
    expect(
      await db.agent.findUnique({ where: { id: fagent.id } }),
    ).not.toBeNull();
    await db.workspace.delete({ where: { id: other.id } });
  });

  it("creates encrypted platform-owned channel connections", async () => {
    const a = await createAgent(workspaceId, "Channels", { runtime: "pi-sdk" });
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: "telegram",
      name: "Telegram prod",
      credentials: {
        TELEGRAM_BOT_TOKEN: "123:abc",
        TELEGRAM_ALLOWED_USERS: "42",
      },
    });
    expect(result.error).toBeUndefined();
    const connection = assertDefined(result.connection);
    expect(connection.platform).toBe("telegram");
    expect(connection.inboundToken).toMatch(/^tpchan_/);
    expect(connection.credentialNames).toEqual([
      "TELEGRAM_ALLOWED_USERS",
      "TELEGRAM_BOT_TOKEN",
    ]);

    const raw = await db.agentChannelConnection.findUnique({
      where: { id: connection.id },
    });
    expect(JSON.stringify(raw?.credentials)).not.toContain("123:abc");

    const byToken = await findAgentChannelByInboundToken(
      connection.id,
      connection.inboundToken,
    );
    expect(byToken?.id).toBe(connection.id);
    expect(await listAgentChannelConnections(workspaceId, a.id)).toHaveLength(
      1,
    );

    await deleteAgentChannelConnection(workspaceId, connection.id);
    expect(await listAgentChannelConnections(workspaceId, a.id)).toHaveLength(
      0,
    );
  });

  it("creates QR setup channels before scan-returned credentials exist", async () => {
    const a = await createAgent(workspaceId, "WeCom QR", { runtime: "pi-sdk" });
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: "wecom",
      name: "WeCom setup",
      credentials: {},
    });

    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe("setup_required");
    expect(result.connection?.missingStartCredentialNames).toEqual(
      expect.arrayContaining(["WECOM_BOT_ID", "WECOM_SECRET"]),
    );

    const updated = await updateAgentChannelConnectionCredentials({
      workspaceId,
      connectionId: assertDefined(result.connection).id,
      credentials: {
        WECOM_BOT_ID: "bot-id",
        WECOM_SECRET: "secret",
      },
    });

    expect(updated.error).toBeUndefined();
    expect(updated.connection?.status).toBe("stopped");
    expect(updated.connection?.missingStartCredentialNames).toEqual([]);

    await deleteAgentChannelConnection(
      workspaceId,
      assertDefined(result.connection).id,
    );
  });

  it("requests WeCom QR and saves scan-returned credentials", async () => {
    const a = await createAgent(workspaceId, "WeCom active QR", {
      runtime: "pi-sdk",
    });
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: "wecom",
      name: "WeCom active setup",
      credentials: {},
    });
    const connectionId = assertDefined(result.connection).id;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/generate")) {
        return new Response(
          JSON.stringify({
            data: {
              scode: "scode-1",
              auth_url: "https://work.weixin.qq.com/auth/qr",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/query_result")) {
        return new Response(
          JSON.stringify({
            data: {
              status: "success",
              bot_info: { botid: "bot-id", secret: "secret" },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requested = await requestAgentChannelPairing(
      workspaceId,
      connectionId,
    );
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.qrPayload).toBe(
      "https://work.weixin.qq.com/auth/qr",
    );

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.status).toBe("waiting");
    expect(afterRequest[0].pairing?.providerSessionId).toBe("scode-1");

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe("stopped");
    expect(afterCheck[0].pairing?.status).toBe("ready");
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);

    const raw = await db.agentChannelConnection.findUnique({
      where: { id: connectionId },
    });
    expect(JSON.stringify(raw?.credentials)).not.toContain("secret");

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });

  it("requests Weixin QR and saves confirmed login credentials", async () => {
    const a = await createAgent(workspaceId, "Weixin active QR", {
      runtime: "pi-sdk",
    });
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: "weixin",
      name: "Weixin active setup",
      credentials: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe("setup_required");
    expect(result.connection?.missingStartCredentialNames).toEqual(
      expect.arrayContaining(["WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"]),
    );
    const connectionId = assertDefined(result.connection).id;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/get_bot_qrcode")) {
        return new Response(
          JSON.stringify({
            qrcode: "qr-token-1",
            qrcode_img_content: "https://ilinkai.weixin.qq.com/qr/scan/1",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/get_qrcode_status")) {
        return new Response(
          JSON.stringify({
            status: "confirmed",
            ilink_bot_id: "wx-account-1",
            bot_token: "wx-token-1",
            baseurl: "https://weixin-next.example.com",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requested = await requestAgentChannelPairing(
      workspaceId,
      connectionId,
    );
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.qrPayload).toBe(
      "https://ilinkai.weixin.qq.com/qr/scan/1",
    );

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.provider).toBe("weixin_ilink_qr");
    expect(afterRequest[0].pairing?.providerSessionId).toBe("qr-token-1");

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe("stopped");
    expect(afterCheck[0].pairing?.status).toBe("ready");
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);
    expect(afterCheck[0].runnerSupported).toBe(true);
    expect(afterCheck[0].credentialNames).toEqual([
      "WEIXIN_ACCOUNT_ID",
      "WEIXIN_BASE_URL",
      "WEIXIN_TOKEN",
    ]);

    const raw = await db.agentChannelConnection.findUnique({
      where: { id: connectionId },
    });
    expect(JSON.stringify(raw?.credentials)).not.toContain("wx-token-1");

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });

  it("requests DingTalk device QR and saves registered credentials", async () => {
    const a = await createAgent(workspaceId, "DingTalk active QR", {
      runtime: "pi-sdk",
    });
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: "dingtalk",
      name: "DingTalk active setup",
      credentials: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe("setup_required");
    const connectionId = assertDefined(result.connection).id;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (url.endsWith("/app/registration/init")) {
        expect(body.source).toBe("openClaw");
        return new Response(
          JSON.stringify({
            errcode: 0,
            nonce: "nonce-1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/app/registration/begin")) {
        expect(body.nonce).toBe("nonce-1");
        return new Response(
          JSON.stringify({
            errcode: 0,
            device_code: "device-1",
            verification_uri_complete:
              "https://oapi.dingtalk.com/device/verify?code=1",
            expires_in: 7200,
            interval: 3,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/app/registration/poll")) {
        expect(body.device_code).toBe("device-1");
        return new Response(
          JSON.stringify({
            errcode: 0,
            status: "SUCCESS",
            client_id: "ding-client-id",
            client_secret: "ding-client-secret",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requested = await requestAgentChannelPairing(
      workspaceId,
      connectionId,
    );
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.provider).toBe("dingtalk_device_qr");
    expect(requested.pairing?.qrPayload).toBe(
      "https://oapi.dingtalk.com/device/verify?code=1",
    );

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.status).toBe("waiting");
    expect(afterRequest[0].pairing?.providerSessionId).toBe("device-1");

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe("stopped");
    expect(afterCheck[0].pairing?.status).toBe("ready");
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);
    expect(afterCheck[0].credentialNames).toEqual([
      "DINGTALK_CLIENT_ID",
      "DINGTALK_CLIENT_SECRET",
    ]);

    const raw = await db.agentChannelConnection.findUnique({
      where: { id: connectionId },
    });
    expect(JSON.stringify(raw?.credentials)).not.toContain(
      "ding-client-secret",
    );

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });
});
