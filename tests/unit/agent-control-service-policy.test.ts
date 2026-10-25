import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigurationError } from "@/lib/agents/mutations";
import {
  createAgentFromControl,
  getAgentControlAgent,
  inspectAgentControlDeployment,
  listAgentControlAgents,
  listAgentControlResources,
  sendAgentControlMessage,
} from "@/lib/agents/control-service";
import type { CreateAgentFromControlInput } from "@/lib/agents/control-service";

const mocks = vi.hoisted(() => ({
  db: {
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    modelProvider: { findMany: vi.fn() },
    deployment: { findFirst: vi.fn(), findMany: vi.fn() },
    installedSkill: { findMany: vi.fn() },
    toolkit: { findMany: vi.fn() },
    sandbox: { findMany: vi.fn() },
  },
  create: vi.fn(),
  message: vi.fn(),
  tools: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agents/mutations", () => ({
  createConfiguredAgent: mocks.create,
  AgentConfigurationError: class extends Error {},
}));
vi.mock("@/lib/agents/message-service", () => ({
  runWorkspaceAgentMessage: mocks.message,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
  effectiveStatuses: () => new Map(),
}));
vi.mock("@/lib/process/mcp-client", () => ({ listMcpTools: mocks.tools }));

const input: CreateAgentFromControlInput = {
  name: "Agent",
  runtime: "pi-sdk",
  providerIds: [],
  maxSteps: 10,
  deploymentIds: [],
  installedSkillIds: [],
  toolkitIds: [],
  sandboxIds: [],
  subAgentIds: [],
};
function agent() {
  return {
    id: "agent/id",
    name: "Agent",
    slug: "agent",
    runtimeKind: "pi-sdk",
    retiredAt: null,
    currentRevisionVersion: 1,
    providerId: "provider",
    provider: { id: "provider", name: "Provider", format: "openai" } as {
      id: string;
      name: string;
      format: string;
    } | null,
    model: "model",
    modelProviders: [] as {
      providerId: string;
      provider: { name: string; format: string };
    }[],
    runtime: null as {
      status: string;
      image: string;
      sandbox: { deploymentId: string; deployment: { status: string } };
    } | null,
    systemPrompt: null,
    maxSteps: 10,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    servers: [],
    skills: [],
    toolkits: [],
    sandboxes: [],
    subAgents: [],
    _count: {
      conversations: 3,
      servers: 1,
      skills: 2,
      toolkits: 3,
      sandboxes: 4,
      subAgents: 2,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.agent.findFirst.mockResolvedValue(agent());
  mocks.create.mockResolvedValue({ id: "agent/id" });
});

describe("agent control configuration and safe serialization", () => {
  it.each([
    {
      runtimeKind: "pi-sdk",
      retiredAt: null,
      currentRevisionVersion: 0,
      ready: false,
      readOnly: false,
    },
    {
      runtimeKind: "pi-sdk",
      retiredAt: new Date(0),
      currentRevisionVersion: 1,
      ready: false,
      readOnly: true,
    },
    {
      runtimeKind: "pi",
      retiredAt: null,
      currentRevisionVersion: 1,
      ready: false,
      readOnly: true,
    },
  ])(
    "never advertises draft or retired execution as ready: %j",
    async ({ ready, readOnly, ...state }) => {
      mocks.db.agent.findFirst.mockResolvedValue({ ...agent(), ...state });
      await expect(
        getAgentControlAgent("workspace", "slug", "agent/id"),
      ).resolves.toMatchObject({ ready, readOnly });
    },
  );
  it.each([
    { ...input, model: "model" },
    { ...input, runtime: "hermes" as const, providerId: "provider" },
    { ...input, runtime: "hermes" as const, model: "model" },
    { ...input, runtime: "hermes" as const, systemPrompt: "prompt" },
  ])("rejects incompatible creation configuration %j", async (value) => {
    await expect(
      createAgentFromControl(
        "workspace",
        "slug",
        value as CreateAgentFromControlInput,
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("serializes only safe agent metadata with escaped resource paths", async () => {
    expect(
      await getAgentControlAgent("workspace", "workspace /", "agent/id"),
    ).toMatchObject({
      configured: true,
      ready: true,
      runtime: { kind: "pi-sdk", status: null, image: null },
      consolePath: "/app/workspace%20%2F/agents/agent%2Fid",
      messageEndpoint: "/api/v1/agents/agent%2Fid/messages",
      createdAt: "1970-01-01T00:00:00.000Z",
      conversationCount: 3,
    });
    mocks.db.agent.findFirst.mockResolvedValue(null);
    await expect(
      getAgentControlAgent("workspace", "slug", "unknown"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it.each(["error", "setup_required", "stopped", "running"])(
    "preserves Hermes runtime status %s without inventing readiness",
    async (status) => {
      const row = agent();
      row.runtimeKind = "hermes";
      row.modelProviders = [
        {
          providerId: "provider",
          provider: { name: "Provider", format: "openai" },
        },
      ];
      row.runtime = {
        status,
        image: "image",
        sandbox: { deploymentId: "runtime", deployment: { status: "running" } },
      };
      mocks.db.agent.findFirst.mockResolvedValue(row);
      const result = await getAgentControlAgent("workspace", "slug", row.id);
      expect(result.runtime.status).toBe(
        ["error", "setup_required"].includes(status) ? status : "running",
      );
      expect(result.ready).toBe(false);
      expect(result.readOnly).toBe(true);
      expect(result.model).toEqual({
        providerIds: ["provider"],
        providers: [{ name: "Provider", format: "openai" }],
      });
    },
  );
  it("marks unconfigured agents not ready and counts all attached tool resources", async () => {
    const pi = agent();
    pi.provider = null;
    const hermes = agent();
    hermes.runtimeKind = "hermes";
    mocks.db.agent.findMany.mockResolvedValue([pi, hermes, agent()]);
    const results = await listAgentControlAgents("workspace");
    expect(results.map((result) => [result.configured, result.ready])).toEqual([
      [false, false],
      [false, false],
      [true, true],
    ]);
    expect(results[0]).toMatchObject({
      providerName: null,
      counts: { tools: 10, conversations: 3, subAgents: 2 },
    });
    mocks.db.agent.findFirst.mockResolvedValue(pi);
    expect(
      await getAgentControlAgent("workspace", "slug", pi.id),
    ).toMatchObject({ ready: false, model: { provider: null } });
  });
  it.each(["pi", "hermes", "hermes-rpc", "claude-code", "dsh", "native"])(
    "rejects retired %s creation before persistence",
    async (runtime) => {
      await expect(
        createAgentFromControl("workspace", "slug", {
          ...input,
          runtime,
        } as CreateAgentFromControlInput),
      ).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("maps configuration errors but propagates unexpected persistence failures", async () => {
    mocks.create
      .mockRejectedValueOnce(new AgentConfigurationError("invalid relation"))
      .mockRejectedValueOnce(new Error("storage failed"));
    await expect(
      createAgentFromControl("workspace", "slug", input),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      message: "invalid relation",
    });
    await expect(
      createAgentFromControl("workspace", "slug", input),
    ).rejects.toThrow("storage failed");
  });
  it("creates unbound Pi agents without syncing managed runtimes", async () => {
    const result = await createAgentFromControl("workspace", "slug", {
      ...input,
      systemPrompt: "  ",
    });
    expect(result.runtimeSync).toEqual({ status: "pi-sdk" });
    expect(mocks.create).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({
        systemPrompt: null,
        providerId: null,
        model: null,
        providerIds: [],
      }),
      expect.any(Object),
      { runtime: "pi-sdk" },
    );
  });
});

describe("agent control deployment and execution policies", () => {
  it("refuses unknown deployments and avoids inspecting stopped tools", async () => {
    mocks.db.deployment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "deployment",
        name: "Imported",
        source: "import",
        sourceRef: null,
        server: null,
        status: "stopped",
      });
    await expect(
      inspectAgentControlDeployment("workspace", "unknown"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await inspectAgentControlDeployment("workspace", "deployment"),
    ).toMatchObject({
      tools: [],
      note: expect.stringContaining("Start this MCP deployment"),
    });
    expect(mocks.tools).not.toHaveBeenCalled();
  });
  it("applies stored tool exposure before serializing MCP schemas", async () => {
    mocks.db.deployment.findFirst.mockResolvedValue({
      id: "deployment",
      status: "running",
      serverId: null,
      name: "Imported",
      source: "import",
      sourceRef: "ref",
      server: null,
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["allowed", "full"],
    });
    mocks.tools.mockResolvedValue([
      { name: "allowed" },
      {
        name: "full",
        description: "Full tool",
        inputSchema: { type: "object" },
      },
      { name: "hidden" },
    ]);
    const result = await inspectAgentControlDeployment(
      "workspace",
      "deployment",
    );
    expect(result.tools).toEqual([
      {
        name: "allowed",
        description: "allowed",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "full",
        description: "Full tool",
        inputSchema: { type: "object" },
      },
    ]);
    expect(result.note).toBeNull();
  });
  it.each([
    [404, "not_found", "Not found"],
    [400, "not_configured", "Not found"],
    [
      503,
      "unavailable",
      "Agent runtime is unavailable. Try again or inspect the Agent console.",
    ],
  ])("maps execution response %i", async (status, code, message) => {
    mocks.message.mockResolvedValue({ status, body: { error: "Not found" } });
    await expect(
      sendAgentControlMessage("workspace", {
        agentId: "agent",
        message: "hello",
      }),
    ).rejects.toMatchObject({ code, message });
  });
  it("hides thrown execution details and returns successful deliveries", async () => {
    mocks.message.mockRejectedValueOnce(new Error("secret"));
    await expect(
      sendAgentControlMessage("workspace", {
        agentId: "agent",
        message: "hello",
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message:
        "Agent execution failed. Try again or inspect the Agent console.",
    });
    const body = {
      agentId: "agent",
      conversationId: "conversation",
      delivery: "reply",
      message: "answer",
    };
    mocks.message.mockResolvedValue({ status: 200, body });
    expect(
      await sendAgentControlMessage(
        "workspace",
        { agentId: "agent", message: "hello" },
        "actor",
      ),
    ).toEqual(body);
  });
  it("lists resources with descriptions and stored status fallbacks", async () => {
    mocks.db.modelProvider.findMany.mockResolvedValue([]);
    mocks.db.deployment.findMany.mockResolvedValue([
      {
        id: "deployment",
        name: "Imported",
        source: "import",
        sourceRef: null,
        server: null,
        status: "stopped",
      },
    ]);
    mocks.db.installedSkill.findMany.mockResolvedValue([
      {
        id: "skill",
        skillId: null,
        name: "Skill",
        slug: "skill",
        source: "import",
        skill: null,
        description: "Installed",
        status: "published",
        userInvocable: true,
        agentInvocable: false,
      },
    ]);
    mocks.db.toolkit.findMany.mockResolvedValue([
      {
        id: "toolkit",
        name: "Toolkit",
        slug: "toolkit",
        enabled: false,
        _count: { servers: 2, skills: 3 },
      },
    ]);
    mocks.db.sandbox.findMany.mockResolvedValue([
      {
        id: "sandbox",
        name: "Sandbox",
        slug: "sandbox",
        kind: "docker",
        deploymentId: "runtime",
        deployment: { status: "running" },
      },
    ]);
    expect(await listAgentControlResources("workspace")).toMatchObject({
      deployments: [{ status: "stopped", description: null }],
      skills: [{ description: "Installed", agentInvocable: false }],
      toolkits: [{ serverCount: 2, skillCount: 3 }],
      sandboxes: [{ status: "running" }],
    });
  });
});
