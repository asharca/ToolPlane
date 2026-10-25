// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSandbox: vi.fn(),
  updateWork: vi.fn(),
  createAgentRuntimeToken: vi.fn(),
  agent: vi.fn(),
  owner: vi.fn(),
  revision: vi.fn(),
  conversation: vi.fn(),
  provider: vi.fn(),
  packages: vi.fn(),
  runSandboxAgentTurn: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const db = {
    workSession: { updateMany: mocks.updateWork },
    agent: { findFirst: mocks.agent, findUnique: mocks.owner },
    agentRevision: { findFirst: mocks.revision },
    conversation: { findFirst: mocks.conversation },
    modelProvider: { findFirst: mocks.provider },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/agents/pi-session-packages", () => ({
  resolvePiSessionPackages: mocks.packages,
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  ensureAgentConversationSandbox: mocks.ensureSandbox,
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  withAgentExecutionLease: (_input: unknown, run: () => Promise<unknown>) =>
    run(),
}));
vi.mock("@/lib/agents/runtime-access", () => ({
  createAgentRuntimeToken: mocks.createAgentRuntimeToken,
  runtimeMcpProxyUrl: (id: string) => `http://toolplane.test/mcp/${id}`,
  runtimeModelProxyBase: (id: string) => `http://toolplane.test/model/${id}`,
  sandboxRuntimeOrigin: () => "http://toolplane.test",
}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({
  runSandboxAgentTurn: mocks.runSandboxAgentTurn,
}));
vi.mock("@/lib/agents/model", () => ({
  resolveModelContext: () => ({ maxTokens: 128_000, estimated: false }),
}));

import { runDedicatedSandboxTurn } from "@/lib/agents/sandbox-turn";

const provider = {
  id: "provider-1",
  name: "Provider",
  format: "openai" as const,
  baseUrl: "",
  apiKey: "",
};
const liveAgent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  runtimeKind: "pi-sdk",
  retiredAt: null,
  providerId: provider.id,
  provider,
  model: "mutable-model",
  modelProviders: [],
  disabledBuiltinTools: [],
  skills: [],
  knowledgeBases: [],
  piPackages: [],
  servers: [{ deploymentId: "deployment-running", allowedToolNames: ["read"] }],
};
const revision = {
  id: "revision-1",
  version: 1,
  config: {
    schemaVersion: 1,
    runtimeKind: "pi-sdk",
    systemPrompt: "Pinned instructions",
    providerId: provider.id,
    model: "pinned-model",
    modelProviderIds: [],
    maxSteps: 20,
    disabledBuiltinTools: [],
    sandboxTemplateId: "template",
    environment: {
      kind: "docker",
      image: `native@sha256:${"a".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
    skills: [],
    knowledgeBaseIds: [],
    packages: [],
    mcpGrants: [
      {
        deploymentId: "deployment-running",
        definitionChecksum: "b".repeat(64),
        runtimeImageDigest: null,
        runtimeFilesChecksum: "c".repeat(64),
        allowedToolNames: ["read"],
      },
    ],
    a2a: {
      inboundEnabled: false,
      outboundEnabled: false,
      policy: { schemaVersion: 1, targets: [] },
    },
  },
};
describe("dedicated sandbox Agent turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agent.mockImplementation(async ({ where }) =>
      where.id === liveAgent.id && where.workspaceId === liveAgent.workspaceId
        ? liveAgent
        : null,
    );
    mocks.owner.mockImplementation(async ({ where }) =>
      where.id === liveAgent.id
        ? {
            runtimeKind: "pi-sdk",
            retiredAt: null,
            workspace: { status: "active" },
          }
        : null,
    );
    mocks.revision.mockImplementation(async ({ where }) =>
      where.id === revision.id && where.agentId === liveAgent.id
        ? revision
        : null,
    );
    mocks.conversation.mockImplementation(async ({ where }) =>
      where.id === "conversation-1" &&
      where.agentId === liveAgent.id &&
      where.agent.workspaceId === liveAgent.workspaceId
        ? {
            id: "conversation-1",
            agentRevisionId: revision.id,
            legacyRevisionUnresolved: false,
          }
        : null,
    );
    mocks.provider.mockImplementation(async ({ where }) =>
      where.id === provider.id && where.workspaceId === liveAgent.workspaceId
        ? provider
        : null,
    );
    mocks.packages.mockImplementation(async (input) => {
      if (
        input.workspaceId !== liveAgent.workspaceId ||
        input.agentId !== liveAgent.id ||
        input.conversationId !== "conversation-1" ||
        input.sandboxId !== "conversation-sandbox"
      )
        throw new Error("Unexpected session package authority");
      return { packages: [], deploymentIds: ["deployment-running"] };
    });
    mocks.ensureSandbox.mockResolvedValue({
      sandboxId: "conversation-sandbox",
      deploymentId: "conversation-deployment",
    });
    mocks.createAgentRuntimeToken.mockResolvedValue("runtime-token");
    mocks.runSandboxAgentTurn.mockResolvedValue("done");
  });

  it("uses pinned session-authorized MCP deployments rather than caller attachments", async () => {
    await runDedicatedSandboxTurn({
      agent: {
        id: "agent-1",
        workspaceId: "workspace-1",
        runtimeKind: "pi-sdk",
        disabledBuiltinTools: [],
        provider: {
          id: "provider-1",
          name: "Provider",
          format: "openai",
          baseUrl: "",
          apiKey: "",
        },
        model: "model-1",
      },
      conversationId: "conversation-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      deploymentIds: ["deployment-running", "deployment-stopped"],
    });

    expect(mocks.createAgentRuntimeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentIds: ["deployment-running"],
        agentRevisionId: revision.id,
        sandboxId: "conversation-sandbox",
        conversationId: "conversation-1",
      }),
    );
    expect(mocks.runSandboxAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeKind: "pi-sdk",
        piVersion: "0.87.1",
        modelId: "pinned-model",
        systemPrompt: "Pinned instructions",
        mcpServers: [
          {
            deploymentId: "deployment-running",
            url: "http://toolplane.test/mcp/deployment-running",
          },
        ],
      }),
    );
    expect(mocks.packages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      sandboxId: "conversation-sandbox",
      conversationId: "conversation-1",
      contextId: undefined,
      runtimeSessionId: "conversation-1",
    });
  });
  it("does not allocate or mint authority when the persisted revision is unresolved", async () => {
    mocks.conversation.mockResolvedValue({
      id: "conversation-1",
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
    });
    await expect(
      runDedicatedSandboxTurn({
        agent: { ...liveAgent, provider, model: "caller-model" },
        conversationId: "conversation-1",
        messages: [],
      }),
    ).rejects.toThrow("AGENT_REVISION_UNRESOLVED");
    expect(mocks.ensureSandbox).not.toHaveBeenCalled();
    expect(mocks.packages).not.toHaveBeenCalled();
    expect(mocks.createAgentRuntimeToken).not.toHaveBeenCalled();
    expect(mocks.runSandboxAgentTurn).not.toHaveBeenCalled();
  });
  it("does not fall back to the template if allocation fails", async () => {
    mocks.ensureSandbox.mockRejectedValue(new Error("copy failed"));
    await expect(
      runDedicatedSandboxTurn({
        agent: {
          id: "agent-1",
          workspaceId: "workspace-1",
          runtimeKind: "pi-sdk",
          disabledBuiltinTools: [],
          provider: {
            id: "provider-1",
            name: "Provider",
            format: "openai",
            baseUrl: "",
            apiKey: "",
          },
          model: "model-1",
        },
        conversationId: "conversation-1",
        messages: [],
      }),
    ).rejects.toThrow("copy failed");
    expect(mocks.createAgentRuntimeToken).not.toHaveBeenCalled();
    expect(mocks.runSandboxAgentTurn).not.toHaveBeenCalled();
  });
});
