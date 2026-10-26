// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
const mocks = vi.hoisted(() => ({
  live: vi.fn(),
  target: vi.fn(),
  context: vi.fn(),
  agent: vi.fn(),
  run: vi.fn(),
  token: vi.fn(),
  assignments: vi.fn(),
  count: vi.fn(),
  conversation: vi.fn(),
  work: vi.fn(),
  ensureSandbox: vi.fn(),
  findSandbox: vi.fn(),
}));
vi.mock("@/lib/a2a/principal", () => ({
  isLocalGrant: (g: { kind?: string }) => g.kind === "local",
  assertLiveGrant: mocks.live,
}));
vi.mock("@/lib/a2a/local-policy", () => ({ localTarget: mocks.target }));
vi.mock("@/lib/db", () => ({
  db: {
    a2AContext: { findFirst: mocks.context },
    agentSandbox: { findMany: mocks.assignments },
    a2ATask: { count: mocks.count },
    conversation: { findFirst: mocks.conversation },
    workSession: {
      findUniqueOrThrow: mocks.work,
      findFirst: mocks.work,
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  ensureAgentConversationSandbox: mocks.ensureSandbox,
  findAgentConversationSandbox: mocks.findSandbox,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));
vi.mock("@/lib/agents/resolve", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentTools: () => ({
    deploymentIds: ["live-mcp", "stopped-mcp"],
    skills: [{ name: "test-skill" }],
  }),
}));
vi.mock("@/lib/process/supervisor", () => ({
  liveStatus: (id: string) => (id === "live-mcp" ? "running" : "stopped"),
}));
vi.mock("@/lib/agents/model", () => ({
  resolveModelContext: () => ({ maxTokens: 128000, estimated: false }),
}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({
  runSandboxAgentTurn: mocks.run,
}));
vi.mock("@/lib/agents/pi-harness", () => ({ executePiHarnessTask: vi.fn() }));
vi.mock("@/lib/agents/runtime-access", () => ({
  createAgentRuntimeToken: mocks.token,
  runtimeMcpProxyUrl: (id: string) => `https://proxy.test/mcp/${id}`,
  runtimeModelProxyBase: () => "https://proxy.test/model",
  sandboxRuntimeOrigin: () => "https://proxy.test",
}));
import {
  executeLocalTask,
  LOCAL_COLLABORATION_INSTRUCTIONS,
} from "@/lib/a2a/local-executor";
import { localTaskOptions } from "@/lib/a2a/local-task-options";
const grant = {
  kind: "local",
  workspaceId: "ws",
  agentId: "agent",
  ownerKey: "owner",
  targetBinding: "binding",
  expiresAt: Date.now() + 60_000,
  ancestorTaskIds: [],
  ancestorAgentIds: [],
};
const row = () =>
  ({
    id: "task",
    contextId: "a2a-context",
    executionBackend: "legacy",
    leaseToken: "lease",
    grant,
    deadlineAt: new Date(Date.now() + 50_000),
    snapshot: {
      id: "task",
      contextId: "a2a-context",
      status: { state: "TASK_STATE_WORKING" },
      history: [
        {
          messageId: "input",
          role: "ROLE_USER",
          parts: [{ text: "Review the patch" }],
        },
        {
          messageId: "output",
          role: "ROLE_AGENT",
          parts: [{ text: "Progress" }],
        },
      ],
    },
  }) as unknown as A2ATask;
const agent = {
  id: "agent",
  workspaceId: "ws",
  runtimeKind: "pi",
  piPackages: [],
  provider: { id: "provider", apiKey: "fixture-secret" },
  model: "model",
  maxSteps: 10,
  disabledBuiltinTools: ["dangerous-tool"],
  systemPrompt: "Follow task policy",
  publicRuntimeAllocation: null,
  a2aInternalEnabled: true,
  subAgents: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.live.mockResolvedValue(undefined);
  mocks.ensureSandbox.mockResolvedValue({
    sandboxId: "sandbox",
    deploymentId: "isolated-deployment",
  });
  mocks.findSandbox.mockResolvedValue({
    sandboxId: "sandbox",
    deploymentId: "isolated-deployment",
  });
  mocks.target.mockResolvedValue({ binding: "binding", sandboxId: "sandbox" });
  mocks.context.mockResolvedValue({ id: "a2a-context" });
  mocks.agent.mockResolvedValue(agent);
  mocks.token.mockResolvedValue("scoped-runtime-token");
  mocks.run.mockResolvedValue("review result");
});
describe("historical local TaskExecutor runtime port", () => {
  it.each(["pi", "claude-code", "dsh", "pi-sdk"])(
    "projects a task-scoped %s turn without a private Conversation",
    async (runtimeKind) => {
      mocks.agent.mockResolvedValue({ ...agent, runtimeKind });
      const result = await executeLocalTask(
        row(),
        new AbortController().signal,
      );
      expect(result.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(mocks.context.mock.calls[0][0].where).toMatchObject({
        id: "a2a-context",
        workspaceId: "ws",
        agentId: "agent",
        targetKind: "local",
        targetBinding: "binding",
      });
      expect(mocks.token.mock.calls[0][0]).toMatchObject({
        a2aTaskId: "task",
        a2aLeaseToken: "lease",
        deploymentIds: ["live-mcp"],
      });
      const projection = mocks.run.mock.calls[0][0];
      expect(projection).toMatchObject({
        runtimeKind,
        runtimeSessionId: "a2a-context",
        sandboxId: "sandbox",
        runtimeAccessToken: "scoped-runtime-token",
        modelId: "model",
        disabledBuiltinTools: ["dangerous-tool"],
      });
      if (runtimeKind === "pi-sdk") expect(projection.piPackages).toEqual([]);
      else expect(projection).not.toHaveProperty("piPackages");
      expect(projection.mcpServers).toEqual([
        { deploymentId: "live-mcp", url: "https://proxy.test/mcp/live-mcp" },
        {
          deploymentId: "toolplane-a2a",
          url: "https://proxy.test/api/v1/agent-runtime/a2a/task/mcp",
        },
      ]);
      expect(projection.systemPrompt).toContain(
        LOCAL_COLLABORATION_INSTRUCTIONS,
      );
      expect(projection.messages.map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(projection.mcpServers)).not.toContain(
        "fixture-secret",
      );
      expect(mocks.live).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    "exposes ordinary chat collaboration tools only when a child is selected: %s",
    async (selected) => {
      mocks.agent.mockResolvedValue({
        ...agent,
        a2aInternalEnabled: false,
        subAgents: selected
          ? [{ child: { id: "child", name: "Reviewer" } }]
          : [],
      });
      const entryPolicy = {
        kind: "chat",
        sourceId: "conversation",
        sourceAgentId: "agent",
        binding: "source-binding",
      };
      const task = {
        ...row(),
        grant: { ...grant, ancestorTaskIds: [], entryPolicy },
      };
      await executeLocalTask(task, new AbortController().signal);
      const projection = mocks.run.mock.calls[0][0];
      expect(projection.mcpServers).toEqual([
        { deploymentId: "live-mcp", url: "https://proxy.test/mcp/live-mcp" },
        ...(selected
          ? [
              {
                deploymentId: "toolplane-a2a",
                url: "https://proxy.test/api/v1/agent-runtime/a2a/task/mcp",
              },
            ]
          : []),
      ]);
      if (selected)
        expect(projection.systemPrompt).toContain(
          LOCAL_COLLABORATION_INSTRUCTIONS,
        );
      else expect(projection.systemPrompt).toBe("Follow task policy");
    },
  );
  it("will not dispatch a public task or unclaimed local task", async () => {
    await expect(
      executeLocalTask({ ...row(), grant: {} }, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      executeLocalTask(
        { ...row(), leaseToken: null },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rejects a changed context before projecting credentials", async () => {
    mocks.context.mockResolvedValue(null);
    await expect(
      executeLocalTask(row(), new AbortController().signal),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not publish a result when cancellation or authority revocation wins", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async () => {
      controller.abort();
      return "late";
    });
    await expect(executeLocalTask(row(), controller.signal)).rejects.toThrow();
    mocks.run.mockResolvedValue("late");
    mocks.live.mockRejectedValue(new Error("revoked"));
    await expect(
      executeLocalTask(row(), new AbortController().signal),
    ).rejects.toThrow();
  });
  it("rejects oversized output and does not convert executor errors to successful text", async () => {
    mocks.run.mockResolvedValue("x".repeat(65537));
    await expect(
      executeLocalTask(row(), new AbortController().signal),
    ).rejects.toThrow("output limit");
    mocks.run.mockRejectedValue(new Error("executor stopped"));
    await expect(
      executeLocalTask(row(), new AbortController().signal),
    ).rejects.toThrow("executor stopped");
  });
  it("rejects an unknown backend instead of falling back to the old executor", async () => {
    await expect(
      executeLocalTask(
        { ...row(), executionBackend: "unknown" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unknown A2A execution backend");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("local task claim option boundaries", () => {
  it.each([
    null,
    { ...agent, provider: null },
    { ...agent, model: null },
    { ...agent, publicRuntimeAllocation: { id: "public" } },
  ])(
    "rejects unavailable local agents %# before minting credentials",
    async (value) => {
      mocks.agent.mockResolvedValue(value);
      await expect(
        localTaskOptions(row(), new AbortController().signal, "Collaborate"),
      ).rejects.toThrow("Local target unavailable");
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  it.each(["legacy", "pi-harness"])(
    "rejects cleanup without a bound native operation for %s",
    async (executionBackend) => {
      await expect(
        localTaskOptions(
          { ...row(), executionBackend, nativeOperationId: null },
          new AbortController().signal,
          "",
          true,
        ),
      ).rejects.toThrow("bound Pi operation");
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  it("rejects cleanup when its durable mapping is missing", async () => {
    mocks.findSandbox.mockResolvedValue(null);
    await expect(
      localTaskOptions(
        {
          ...row(),
          executionBackend: "pi-harness",
          nativeOperationId: "operation",
        },
        new AbortController().signal,
        "",
        true,
      ),
    ).rejects.toThrow("Bound native sandbox unavailable");
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("projects cleanup without live-grant checks, MCP tools, or collaboration access", async () => {
    mocks.findSandbox.mockResolvedValue({
      sandboxId: "cleanup-sandbox",
      deploymentId: "cleanup-deployment",
    });
    mocks.count.mockResolvedValue(0);
    const options = await localTaskOptions(
      {
        ...row(),
        executionBackend: "pi-harness",
        nativeOperationId: "operation",
      },
      new AbortController().signal,
      "Collaborate",
      true,
    );
    expect(options.sandboxId).toBe("cleanup-sandbox");
    expect(options.mcpServers).toEqual([]);
    expect(options.systemPrompt).toBe("Follow task policy");
    expect(options.piHarness).toMatchObject({
      communicationEnabled: false,
      historyRequired: false,
      sessionRequired: false,
    });
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.findSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "a2a-context", cleanup: true }),
    );
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.token.mock.calls[0][0].deploymentIds).toEqual([]);
  });

  it("restricts resumed work to snapshotted deployments and skills", async () => {
    mocks.work.mockResolvedValue({
      conversationId: "work-conversation",
      runtimeSnapshot: {
        deploymentIds: ["stopped-mcp"],
        installedSkillIds: ["missing"],
        systemPrompt: "Frozen policy",
      },
    });
    const task = {
      ...row(),
      grant: {
        ...grant,
        entryPolicy: {
          kind: "work",
          sourceId: "work",
          workingDirectory: "project",
        },
      },
    };
    const options = await localTaskOptions(
      task,
      new AbortController().signal,
      "Collaborate",
    );
    expect(options.skills).toEqual([]);
    expect(options.workingDirectory).toBe("project");
    expect(options.systemPrompt).toBe("Frozen policy\n\nCollaborate");
    expect(mocks.token.mock.calls[0][0].deploymentIds).toEqual([]);
    expect(options.mcpServers).toHaveLength(1);
  });

  it("restores explicit chat reasoning and native continuation requirements", async () => {
    mocks.conversation.mockResolvedValue({ reasoningEffort: "high" });
    mocks.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const options = await localTaskOptions(
      {
        ...row(),
        executionBackend: "pi-harness",
        grant: { ...grant, entryPolicy: { kind: "chat", sourceId: "chat" } },
      },
      new AbortController().signal,
      "Collaborate",
    );
    expect(options.piHarness).toMatchObject({
      thinkingLevel: "high",
      historyRequired: true,
      sessionRequired: true,
      communicationEnabled: true,
    });
    expect(options.nativeApprovalUrl).toContain("/a2a/task/approvals");
    expect(mocks.token.mock.calls[0][0]).toMatchObject({
      a2aTaskId: "task",
      a2aLeaseToken: "lease",
      a2aApprovalRequired: true,
    });
  });
});
