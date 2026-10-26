// @vitest-environment node
import { assertDefined } from "../assert-defined";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";
import {
  createAgent,
  createConfiguredAgent,
  deleteAgent,
  deleteProvider,
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  ProviderModelError,
  updateAgent,
  updateAgentModelSelection,
  setAgentTools,
  setProviderModels,
  updateProvider,
  appendMessage,
  appendConversationTurn,
  createConversation,
  ensureConversationRuntimeSession,
} from "@/lib/agents/mutations";
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
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
    data: { workspaceId, serverId: server.id },
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

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("keeps conversation mappings workspace-scoped and prevents template reassignment or data detachment", async () => {
    const agent = await createAgent(workspaceId, "Isolated conversation", {
      runtime: "pi",
    });
    const assigned = await db.agentSandbox.findFirstOrThrow({
      where: { agentId: agent.id },
    });
    const isolated = await createDockerSandbox("Conversation files");
    const replacement = await createDockerSandbox("Replacement template");
    await db.sandbox.update({
      where: { id: isolated.id },
      data: {
        config: {
          managedBy: "agent-conversation",
          agentId: agent.id,
          sourceSandboxId: assigned.sandboxId,
        },
      },
    });
    const conversation = await db.conversation.create({
      data: { agentId: agent.id, sandboxId: isolated.id },
    });
    const binding = {
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
    };
    try {
      await expect(findAgentConversationSandbox(binding)).resolves.toEqual({
        sandboxId: isolated.id,
        deploymentId: isolated.deploymentId,
      });
      await expect(
        findAgentConversationSandbox({
          ...binding,
          workspaceId: "another-workspace",
        }),
      ).rejects.toThrow();
      await expect(
        findAgentConversationSandbox({ ...binding, agentId: "another-agent" }),
      ).rejects.toThrow();
      await expect(
        setAgentTools(workspaceId, agent.id, {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
          sandboxIds: [replacement.id],
        }),
      ).rejects.toThrow(/conversation/i);
      expect(
        (
          await db.agentSandbox.findFirstOrThrow({
            where: { agentId: agent.id },
          })
        ).sandboxId,
      ).toBe(assigned.sandboxId);
      await expect(
        db.sandbox.delete({ where: { id: isolated.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
      expect(
        (
          await db.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
          })
        ).sandboxId,
      ).toBe(isolated.id);
    } finally {
      await db.conversation.delete({ where: { id: conversation.id } });
    }
  });

  it("creates an agent with a unique slug", async () => {
    const a = await createAgent(workspaceId, "My Agent", { runtime: "pi" });
    expect(a.slug).toBe("my-agent");
    const b = await createAgent(workspaceId, "My Agent", { runtime: "pi" });
    expect(b.slug).toBe("my-agent-1");
    await expect(
      db.agentSandbox.count({ where: { agentId: { in: [a.id, b.id] } } }),
    ).resolves.toBe(2);
  });

  it("serializes concurrent slug allocation within a workspace", async () => {
    const name = `Concurrent Agent ${Date.now()}`;
    const agents = await Promise.all(
      Array.from({ length: 4 }, () =>
        createAgent(workspaceId, name, { runtime: "pi" }),
      ),
    );
    expect(new Set(agents.map(({ slug }) => slug)).size).toBe(4);
  });

  it.each([
    ["pi", "openai"],
    ["claude-code", "anthropic"],
    ["dsh", "openai"],
  ] as const)(
    "creates a %s agent with an automatic exclusive Docker sandbox",
    async (runtime, format) => {
      const suffix = `${runtime}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const provider =
        format === "openai"
          ? { id: providerId }
          : await db.modelProvider.create({
              data: {
                workspaceId,
                name: `Provider ${suffix}`,
                format,
                baseUrl: "https://provider.test/v1",
                apiKey: "secret",
                models: ["model-1"],
              },
            });
      const created = await createConfiguredAgent(
        workspaceId,
        {
          name: `Agent ${suffix}`,
          systemPrompt: "Work carefully.",
          providerId: provider.id,
          model: "model-1",
          maxSteps: 8,
        },
        {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
          sandboxIds: [],
        },
        { runtime },
      );
      const stored = await db.agent.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          sandboxes: {
            include: { sandbox: { include: { deployment: true } } },
          },
        },
      });

      expect(stored.runtimeKind).toBe(runtime);
      expect(stored.providerId).toBe(provider.id);
      expect(stored.sandboxes).toHaveLength(1);
      const link = stored.sandboxes[0];
      expect(link).toMatchObject({ isDefault: true });
      expect(link.sandbox).toMatchObject({
        kind: "docker",
        image: DEFAULT_SANDBOX_IMAGE,
        network: "isolated",
        deployment: {
          status: "stopped",
          source: "sandbox",
          sourceRef: DEFAULT_SANDBOX_IMAGE,
        },
      });
      expect(link.sandbox.deployment.installCfg).toMatchObject({
        sandboxId: link.sandboxId,
        kind: "docker",
        image: DEFAULT_SANDBOX_IMAGE,
        network: "isolated",
        volumeName: sandboxVolumeName(link.sandboxId),
        env: {},
        allowSudo: false,
      });
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
          sandboxIds: [],
        },
        { runtime: "pi" },
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
      { runtime: "pi" },
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
        [providerId],
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
      { runtime: "pi" },
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

  it("rejects invalid sandbox and provider bindings for sandbox harness runtimes atomically", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    async function sandbox(kind: string, network: string) {
      const deployment = await db.deployment.create({
        data: {
          workspaceId,
          name: `Invalid sandbox ${suffix}`,
          source: "sandbox",
          status: "stopped",
        },
      });
      return db.sandbox.create({
        data: {
          workspaceId,
          deploymentId: deployment.id,
          name: `Invalid sandbox ${suffix}`,
          slug: `invalid-${kind}-${network}-${deployment.id}`,
          kind,
          network,
        },
      });
    }
    const dockerOne = await sandbox("docker", "isolated");
    const dockerTwo = await sandbox("docker", "isolated");
    const connector = await sandbox("connector", "isolated");
    const offline = await sandbox("docker", "none");
    const anthropic = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Anthropic ${suffix}`,
        format: "anthropic",
        baseUrl: "https://anthropic.test",
        apiKey: "secret",
        models: ["model-1"],
      },
    });
    const piProvider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Pi ${suffix}`,
        format: "pi:openai",
        baseUrl: "https://pi.test",
        apiKey: "secret",
      },
    });
    const cfg = (selectedProviderId: string) => ({
      name: `Invalid harness ${suffix}`,
      systemPrompt: null,
      providerId: selectedProviderId,
      model: "model-1",
      maxSteps: 8,
    });
    const tools = (sandboxIds: string[]) => ({
      deploymentIds: [],
      installedSkillIds: [],
      toolkitIds: [],
      sandboxIds,
    });
    const before = await db.agent.count({ where: { workspaceId } });

    for (const runtime of ["pi", "claude-code", "dsh"] as const) {
      const selectedProviderId =
        runtime === "claude-code" ? anthropic.id : providerId;
      await expect(
        createConfiguredAgent(
          workspaceId,
          cfg(selectedProviderId),
          tools([dockerOne.id, dockerTwo.id]),
          { runtime },
        ),
      ).rejects.toThrow("requires exactly one Docker sandbox");
      await expect(
        createConfiguredAgent(
          workspaceId,
          cfg(selectedProviderId),
          tools([connector.id]),
          { runtime },
        ),
      ).rejects.toThrow("requires exactly one Docker sandbox");
      await expect(
        createConfiguredAgent(
          workspaceId,
          cfg(selectedProviderId),
          tools([offline.id]),
          { runtime },
        ),
      ).rejects.toThrow("requires a networked Docker sandbox");
    }
    const claudeWithOpenAi = await createConfiguredAgent(
      workspaceId,
      cfg(providerId),
      tools([dockerOne.id]),
      { runtime: "claude-code" },
    );
    expect(claudeWithOpenAi.runtimeKind).toBe("claude-code");
    await db.agent.delete({ where: { id: claudeWithOpenAi.id } });
    await expect(
      createConfiguredAgent(
        workspaceId,
        cfg(piProvider.id),
        tools([dockerOne.id]),
        { runtime: "dsh" },
      ),
    ).rejects.toThrow('does not support provider format "pi:openai"');
    await expect(
      createConfiguredAgent(
        workspaceId,
        cfg(piProvider.id),
        tools([dockerOne.id]),
        { runtime: "pi" },
      ),
    ).rejects.toThrow('does not support provider format "pi:openai"');
    expect(await db.agent.count({ where: { workspaceId } })).toBe(before);
  });

  it("preserves dedicated sandbox bindings when settings submit incompatible values", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Claude provider ${suffix}`,
        format: "anthropic",
        baseUrl: "https://anthropic.test",
        apiKey: "secret",
        models: ["claude-sonnet"],
      },
    });
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: `Claude sandbox ${suffix}`,
        source: "sandbox",
        status: "stopped",
      },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId,
        deploymentId: deployment.id,
        name: `Claude sandbox ${suffix}`,
        slug: `claude-sandbox-${suffix}`,
        kind: "docker",
        network: "isolated",
      },
    });
    const agent = await createConfiguredAgent(
      workspaceId,
      {
        name: `Claude agent ${suffix}`,
        systemPrompt: null,
        providerId: provider.id,
        model: "claude-sonnet",
        maxSteps: 8,
      },
      {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [sandbox.id],
      },
      { runtime: "claude-code" },
    );

    const piProvider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Pi native provider ${suffix}`,
        format: "pi:openai",
        baseUrl: "https://pi.test",
        apiKey: "secret",
      },
    });

    await expect(
      setAgentTools(workspaceId, agent.id, {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [],
      }),
    ).rejects.toThrow("requires exactly one Docker sandbox");
    await expect(
      updateAgent(workspaceId, agent.id, {
        name: agent.name,
        systemPrompt: null,
        providerId,
        model: "gpt-4.1",
        maxSteps: 8,
      }),
    ).resolves.toBeUndefined();
    await expect(
      updateAgentModelSelection(
        workspaceId,
        agent.id,
        [piProvider.id],
        "gpt-native",
      ),
    ).rejects.toThrow('does not support provider format "pi:openai"');
    await expect(
      db.agentSandbox.count({
        where: { agentId: agent.id, sandboxId: sandbox.id },
      }),
    ).resolves.toBe(1);
    await expect(
      createConfiguredAgent(
        workspaceId,
        {
          name: `Pi agent ${suffix}`,
          systemPrompt: null,
          providerId,
          model: "gpt-4.1",
          maxSteps: 8,
        },
        {
          deploymentIds: [],
          installedSkillIds: [],
          toolkitIds: [],
          sandboxIds: [sandbox.id],
        },
        { runtime: "pi" },
      ),
    ).rejects.toThrow("already assigned to agent");

    const piSandbox = await createDockerSandbox("Pi agent workspace");
    const piAgent = await createConfiguredAgent(
      workspaceId,
      {
        name: `Pi agent ${suffix}`,
        systemPrompt: null,
        providerId,
        model: "gpt-4.1",
        maxSteps: 8,
      },
      {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [piSandbox.id],
      },
      { runtime: "pi" },
    );
    await expect(
      setAgentTools(workspaceId, piAgent.id, {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [],
      }),
    ).rejects.toThrow("requires exactly one Docker sandbox");
    await expect(
      setAgentTools(workspaceId, piAgent.id, {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [sandbox.id],
      }),
    ).rejects.toThrow("already assigned to agent");
    await expect(
      updateAgentModelSelection(
        workspaceId,
        piAgent.id,
        [piProvider.id],
        "gpt-native",
      ),
    ).rejects.toThrow('does not support provider format "pi:openai"');
    await expect(
      db.agentSandbox.findMany({ where: { agentId: piAgent.id } }),
    ).resolves.toEqual([
      expect.objectContaining({ sandboxId: piSandbox.id, isDefault: true }),
    ]);
  });

  it("does not attach a sandbox with an incomplete data lifecycle operation", async () => {
    const agent = await createAgent(workspaceId, "Blocked sandbox consumer", {
      runtime: "pi",
    });
    const activeSandbox = await createDockerSandbox(
      "Active sandbox consumer workspace",
    );
    await setAgentTools(workspaceId, agent.id, {
      deploymentIds: [],
      installedSkillIds: [],
      toolkitIds: [],
      sandboxIds: [activeSandbox.id],
    });
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: "Interrupted clone",
        source: "sandbox",
        status: "copy_failed",
      },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId,
        deploymentId: deployment.id,
        name: "Interrupted clone",
        slug: `interrupted-clone-${Date.now()}`,
        kind: "docker",
        image: "alpine:3.20",
      },
    });

    await expect(
      setAgentTools(workspaceId, agent.id, {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [sandbox.id],
      }),
    ).rejects.toThrow("requires exactly one Docker sandbox");

    await expect(
      db.agentSandbox.findMany({ where: { agentId: agent.id } }),
    ).resolves.toEqual([
      expect.objectContaining({ sandboxId: activeSandbox.id, isDefault: true }),
    ]);
    await deleteAgent(workspaceId, agent.id);
    await db.deployment.delete({ where: { id: deployment.id } });
  });

  it("updates config and replaces the attached tools", async () => {
    const a = await createAgent(workspaceId, "Cfg", { runtime: "pi" });
    const sandbox = await createDockerSandbox("Config workspace");
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
      sandboxIds: [sandbox.id],
    });
    const reread = await db.agent.findUnique({
      where: { id: a.id },
      include: { servers: true },
    });
    expect(reread?.name).toBe("Cfg2");
    expect(reread?.model).toBe("gpt-x");
    expect(reread?.servers).toHaveLength(1);

    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [],
      installedSkillIds: [],
      toolkitIds: [],
      sandboxIds: [sandbox.id],
    });
    const after = await db.agent.findUnique({
      where: { id: a.id },
      include: { servers: true },
    });
    expect(after?.servers).toHaveLength(0);
  });

  it("caches provider models", async () => {
    await setProviderModels(workspaceId, providerId, ["gpt-x", "gpt-y"]);
    const p = await db.modelProvider.findUnique({ where: { id: providerId } });
    expect(p?.models).toEqual(["gpt-x", "gpt-y"]);
    expect(p?.modelsFetchedAt).toBeInstanceOf(Date);
  });

  it("keeps manually classified models when refreshing remote models", async () => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Catalog provider ${Date.now()}`,
        format: "openai",
        baseUrl: "https://catalog.test/v1",
        apiKey: "k",
      },
    });
    const manualModel = {
      modelId: "acme/embed-v2",
      name: "Acme Embed v2",
      group: "Acme",
      primaryType: "embedding" as const,
      capabilities: [],
      inputModalities: [],
      contextWindow: 8192,
      maxInputTokens: 8192,
      maxOutputTokens: null,
    };

    await addProviderModels(workspaceId, provider.id, [manualModel]);
    await expect(
      addProviderModels(workspaceId, provider.id, [manualModel]),
    ).rejects.toThrow(ProviderModelError);
    await setProviderModels(workspaceId, provider.id, ["remote-chat-v1"]);
    await updateProviderModel(workspaceId, provider.id, {
      ...manualModel,
      group: "Embeddings",
    });

    const reread = await db.modelProvider.findUnique({
      where: { id: provider.id },
      include: { modelRecords: true },
    });
    expect(reread?.models).toEqual(["remote-chat-v1", "acme/embed-v2"]);
    expect(
      reread?.modelRecords.find(
        ({ modelId }) => modelId === manualModel.modelId,
      ),
    ).toMatchObject({
      name: "Acme Embed v2",
      group: "Embeddings",
      primaryType: "embedding",
      source: "manual",
    });

    await deleteProviderModel(workspaceId, provider.id, manualModel.modelId);
    await expect(
      db.modelProvider.findUnique({ where: { id: provider.id } }),
    ).resolves.toMatchObject({ models: ["remote-chat-v1"] });
    await deleteProvider(workspaceId, provider.id);
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
      runtime: "pi",
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
      runtime: "pi",
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
    const a = await createAgent(workspaceId, "Chat", { runtime: "pi" });
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
      runtime: "pi",
    });
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
      runtime: "pi",
    });
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
      runtime: "pi",
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
    const a = await createAgent(workspaceId, "Scope", { runtime: "pi" });
    const sandbox = await createDockerSandbox("Scoped tools workspace");
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId, fdep.id],
      installedSkillIds: [],
      toolkitIds: [],
      sandboxIds: [sandbox.id],
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
    const a = await createAgent(workspaceId, "ProvScope", { runtime: "pi" });
    await updateAgent(workspaceId, a.id, {
      name: "ProvScope",
      systemPrompt: null,
      providerId: fprov.id,
      model: null,
      maxSteps: 8,
    });
    const reread = await db.agent.findUnique({ where: { id: a.id } });
    expect(reread?.providerId).toBeNull();

    await db.workspace.delete({ where: { id: other.id } });
  });

  it("refuses to create a conversation or delete an agent outside the workspace", async () => {
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
    await deleteAgent(workspaceId, fagent.id);
    expect(
      await db.agent.findUnique({ where: { id: fagent.id } }),
    ).not.toBeNull();
    await db.workspace.delete({ where: { id: other.id } });
  });

  it("creates encrypted platform-owned channel connections", async () => {
    const a = await createAgent(workspaceId, "Channels", { runtime: "pi" });
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
    const a = await createAgent(workspaceId, "WeCom QR", { runtime: "pi" });
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
      runtime: "pi",
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
      runtime: "pi",
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
      runtime: "pi",
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
