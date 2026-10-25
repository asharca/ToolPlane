// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  systemLog: vi.fn(),
  queued: true,
  workFindFirst: vi.fn(),
  workFindUnique: vi.fn(),
  workFindMany: vi.fn(),
  workCount: vi.fn(),
  workUpdateMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  messageCreate: vi.fn(),
  getAgentForRun: vi.fn(),
  resolveAgentTools: vi.fn(),
  runDedicatedSandboxTurn: vi.fn(),
  runNativeEntry: vi.fn(),
  effectiveStatus: vi.fn(),
  generateWorkSessionTitle: vi.fn(),
  approvalCreate: vi.fn(),
  approvalFindUnique: vi.fn(),
  approvalUpdateMany: vi.fn(),
  stopHermesWorkRun: vi.fn(),
  runtimeSession: vi.fn(),
  pinned: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock("@/lib/observability/system", () => ({ systemLog: mocks.systemLog }));
vi.mock("@/lib/db", () => ({
  db: {
    workSession: {
      findFirst: mocks.workFindFirst,
      findUnique: mocks.workFindUnique,
      findMany: mocks.workFindMany,
      count: mocks.workCount,
      updateMany: mocks.workUpdateMany,
    },
    deployment: { findMany: mocks.deploymentFindMany },
    message: { create: mocks.messageCreate },
    workApproval: {
      findUnique: mocks.approvalFindUnique,
      create: mocks.approvalCreate,
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        workSession: { updateMany: mocks.workUpdateMany },
        workApproval: {
          create: mocks.approvalCreate,
          updateMany: mocks.approvalUpdateMany,
        },
      }),
  },
}));
vi.mock("@/lib/agents/queries", () => ({
  getAgentForRun: mocks.getAgentForRun,
}));
vi.mock("@/lib/agents/revisions", () => ({ resolvePinnedAgent: mocks.pinned }));
vi.mock("@/lib/agents/pi-session-packages", () => ({
  resolvePiSessionPackages: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agents/conversation-naming", () => ({
  generateWorkSessionTitle: mocks.generateWorkSessionTitle,
}));
vi.mock("@/lib/agents/mutations", () => ({
  ensureConversationRuntimeSession: mocks.runtimeSession,
}));
vi.mock("@/lib/agents/resolve", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentTools: mocks.resolveAgentTools,
}));
vi.mock("@/lib/agents/native", () => ({
  runNativeAgent: vi.fn(),
  uiMessagesToPi: (
    messages: Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>,
  ) =>
    messages.map((message) => ({
      role: message.role,
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    })),
}));
vi.mock("@/lib/agents/sandbox-turn", () => ({
  runDedicatedSandboxTurn: mocks.runDedicatedSandboxTurn,
}));
vi.mock("@/lib/agents/prompt-invocation", () => ({
  persistAgentPromptInvocation: mocks.prompt,
}));
vi.mock("@/lib/agents/hermes/work", () => ({
  stopHermesWorkRun: mocks.stopHermesWorkRun,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: mocks.effectiveStatus,
  liveStatus: vi.fn(),
}));

vi.mock("@/lib/a2a/ingress", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runNativeEntry: mocks.runNativeEntry,
}));

describe("Work coordinator", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.queued = true;
    mocks.runtimeSession.mockResolvedValue({
      runtimeSessionId: "conversation-1",
      runtimeSessionKey: "agent:agent-1:console:conversation-1",
    });
    delete (globalThis as { __workCoordinator?: unknown }).__workCoordinator;
    delete (globalThis as { __workRunControllers?: unknown })
      .__workRunControllers;
    delete (globalThis as { __workOutputChannels?: unknown })
      .__workOutputChannels;
    mocks.workFindFirst.mockImplementation(async () =>
      mocks.queued
        ? {
            id: "work-1",
            startedAt: null,
          }
        : null,
    );
    mocks.workFindUnique.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
      sandboxId: "sandbox-hermes",
      conversationId: "conversation-1",
      task: "Inspect the repository",
      runtimeKind: "pi-sdk",
      runtimeSnapshot: {
        piPackages: [],
        sandboxId: "sandbox-hermes",
        workingDirectory: ".",
      },
      status: "running",
      sandbox: {
        id: "sandbox-hermes",
        deploymentId: "deployment-hermes",
        deployment: { status: "stopped" },
      },
      conversation: {
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        reasoningEffort: "high",
        messages: [
          {
            id: "message-user",
            role: "user",
            parts: [{ type: "text", text: "Inspect the repository" }],
          },
        ],
      },
    });
    mocks.workFindMany.mockResolvedValue([]);
    mocks.workCount.mockResolvedValue(1);
    mocks.deploymentFindMany.mockResolvedValue([]);
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: [],
      sandboxDeploymentIds: [],
      skills: [],
      subAgents: [],
    });
    mocks.effectiveStatus.mockReturnValue("running");
    mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.status === "queued" && data.status === "running")
        mocks.queued = false;
      return { count: 1 };
    });
    mocks.messageCreate.mockResolvedValue({ id: "message-assistant" });
    mocks.generateWorkSessionTitle.mockResolvedValue("Repository inspection");
    mocks.getAgentForRun.mockResolvedValue({
      id: "agent-1",
      slug: "hermes-worker",
      workspaceId: "workspace-1",
      runtimeKind: "pi-sdk",
      provider: { id: "provider-1", format: "openai" },
      model: "model-a",
      modelProviders: [{ providerId: "provider-1" }],
      systemPrompt: null,
      maxSteps: 12,
      servers: [],
      skills: [],
      toolkits: [],
      sandboxes: [],
      piPackages: [],
    });
    mocks.pinned.mockImplementation(async (agent, agentRevisionId) => ({
      ...agent,
      agentRevisionId,
    }));
    mocks.runDedicatedSandboxTurn.mockResolvedValue("Done");
  });

  it("executes the original owner revision and persists SDK activity", async () => {
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      options.onActivity({
        type: "reasoning",
        status: "running",
        delta: "Inspecting files",
      });
      options.onActivity({ type: "reasoning", status: "completed" });
      options.onActivity({
        type: "tool",
        status: "running",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "file" },
      });
      options.onActivity({
        type: "tool",
        status: "completed",
        toolCallId: "read-1",
        toolName: "read",
        output: "contents",
        durationMs: 10,
      });
      options.onTextDelta("Done");
      return "Done";
    });
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledOnce());
    expect(mocks.pinned).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "revision-1",
      { workspaceId: "workspace-1" },
    );
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            text: "Inspecting files",
          }),
          expect.objectContaining({
            type: "work-tool",
            toolName: "read",
            status: "completed",
          }),
          { type: "text", text: "Done", state: "done" },
        ]),
      }),
    });
  });

  it("persists failed SDK activity without reporting a successful turn", async () => {
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      options.onActivity({
        type: "tool",
        status: "running",
        toolCallId: "unfinished",
        toolName: "read",
        input: {},
      });
      throw new Error("Native runtime stopped");
    });
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() =>
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            error: "Native runtime stopped",
          }),
        }),
      ),
    );
    expect(mocks.messageCreate.mock.calls[0][0].data.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "work-tool",
          toolName: "read",
          status: "failed",
        }),
      ]),
    );
  });

  it("finishes native Pi Work and releases its slot before the title is generated", async () => {
    let resolveTitle!: (value: string) => void;
    mocks.generateWorkSessionTitle.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const { kickWorkCoordinator, isWorkSessionTitlePending } = await import(
      "@/lib/work/coordinator"
    );
    const { subscribeWorkOutput, isWorkRunActive } = await import(
      "@/lib/work/run-control"
    );
    kickWorkCoordinator();

    try {
      await vi.waitFor(() =>
        expect(mocks.generateWorkSessionTitle).toHaveBeenCalled(),
      );
      const { snapshot, unsubscribe } = subscribeWorkOutput(
        "work-1",
        () => undefined,
      );
      unsubscribe();
      expect(snapshot.done).toBe(true);
      expect(isWorkSessionTitlePending("work-1")).toBe(true);
      expect(isWorkRunActive("work-1")).toBe(false);
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "work-1", status: "running" },
          data: expect.objectContaining({ status: "idle" }),
        }),
      );
      expect(
        (globalThis as { __workCoordinator?: { active: Set<string> } })
          .__workCoordinator?.active.size,
      ).toBe(0);
      expect(mocks.messageCreate).toHaveBeenCalledTimes(1);
    } finally {
      resolveTitle("Repository inspection");
    }
    await vi.waitFor(() =>
      expect(isWorkSessionTitlePending("work-1")).toBe(false),
    );
  });

  it("finishes Work when automatic title generation fails", async () => {
    mocks.generateWorkSessionTitle.mockRejectedValueOnce(
      new Error("Naming unavailable"),
    );

    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    const { subscribeWorkOutput } = await import("@/lib/work/run-control");
    kickWorkCoordinator();

    await vi.waitFor(() =>
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "work-1", status: "running" },
          data: expect.objectContaining({ status: "idle" }),
        }),
      ),
    );
    const { snapshot, unsubscribe } = subscribeWorkOutput(
      "work-1",
      () => undefined,
    );
    expect(snapshot.done).toBe(true);
    unsubscribe();
    expect(mocks.systemLog).toHaveBeenCalledWith(
      "warn",
      "[work] work-1 title generation failed",
      expect.any(Error),
    );
  });

  it("labels SDK MCP tools with the workspace deployment and original name", async () => {
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: ["dep", "dep-mcp"],
      sandboxDeploymentIds: [],
      skills: [],
      subAgents: [],
    });
    mocks.deploymentFindMany.mockResolvedValue([
      {
        id: "dep",
        serverId: null,
        server: null,
        name: "Wrong prefix MCP",
        source: "custom",
        sourceRef: null,
      },
      {
        id: "dep-mcp",
        serverId: null,
        server: null,
        name: "Filesystem MCP",
        source: "custom",
        sourceRef: null,
      },
    ]);
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      options.onActivity({
        type: "tool",
        status: "running",
        toolCallId: "read-1",
        toolName: "dep-mcp__read/file",
        deploymentId: "dep-mcp",
        originalToolName: "read/file",
        input: "README.md",
      });
      options.onActivity({
        type: "tool",
        status: "completed",
        toolCallId: "read-1",
        toolName: "dep-mcp__read/file",
        deploymentId: "dep-mcp",
        originalToolName: "read/file",
        output: "Done",
        durationMs: 200,
      });
      return "Done";
    });

    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    const { subscribeWorkOutput } = await import("@/lib/work/run-control");
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput(
      "work-1",
      () => undefined,
    );
    expect(snapshot.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          toolName: "dep-mcp__read/file",
          deploymentName: "Filesystem MCP",
          originalToolName: "read/file",
          durationMs: 200,
        }),
      ]),
    );
    unsubscribe();
    expect(mocks.deploymentFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", id: { in: ["dep", "dep-mcp"] } },
      select: {
        id: true,
        serverId: true,
        name: true,
        source: true,
        sourceRef: true,
        server: { select: { name: true } },
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: "work-tool",
            toolName: "dep-mcp__read/file",
            deploymentName: "Filesystem MCP",
            originalToolName: "read/file",
          }),
        ]),
      }),
    });
  });

  it.each(["pi-sdk"])(
    "streams %s through its conversation runner even when the previous sandbox is stopped",
    async (runtimeKind) => {
      mocks.effectiveStatus.mockReturnValue("stopped");
      mocks.workFindUnique.mockResolvedValue({
        id: "work-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        a2aActorId: "user-1",
        sandboxId: "sandbox-1",
        conversationId: "conversation-1",
        task: "Original task",
        runtimeKind,
        runtimeSnapshot: {
          piPackages: [],
          workingDirectory: "src",
          systemPrompt: "Saved instructions",
        },
        status: "running",
        sandbox: {
          id: "sandbox-1",
          deploymentId: "deployment-1",
          deployment: { status: "running" },
        },
        conversation: {
          agentRevisionId: "revision-1",
          legacyRevisionUnresolved: false,
          messages: [
            {
              id: "old",
              role: "user",
              parts: [{ type: "text", text: "Old tool history" }],
            },
            {
              id: "new-message",
              role: "user",
              parts: [{ type: "text", text: "Inspect the repository" }],
            },
          ],
        },
      });
      mocks.getAgentForRun.mockResolvedValue({
        id: "agent-1",
        runtimeKind,
        provider: { name: "P", format: "openai" },
        model: "test",
        workspaceId: "workspace-1",
        piPackages: [],
      });
      mocks.resolveAgentTools.mockReturnValue({
        deploymentIds: [],
        sandboxDeploymentIds: [],
        skills: [],
        subAgents: [],
      });
      mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
        options.onTextDelta("partial ");
        options.onTextDelta("answer");
        return "partial answer";
      });
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      const { subscribeWorkOutput } = await import("@/lib/work/run-control");
      kickWorkCoordinator();
      await vi.waitFor(() =>
        expect(mocks.messageCreate).toHaveBeenCalledTimes(1),
      );
      expect(mocks.runDedicatedSandboxTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          runtimeSessionId: "conversation-1",
          workingDirectory: "src",
        }),
      );
      expect(mocks.runNativeEntry).not.toHaveBeenCalled();
      const { snapshot, unsubscribe } = subscribeWorkOutput(
        "work-1",
        () => undefined,
      );
      expect(snapshot.done).toBe(true);
      expect(snapshot.text).toContain("partial answer");
      unsubscribe();
      expect(mocks.messageCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: "assistant",
          parts: expect.arrayContaining([
            { type: "text", text: "partial answer", state: "done" },
          ]),
        }),
      });
    },
  );

  it("executes available CLI commands through the sandbox runner", async () => {
    const base = await mocks.workFindUnique();
    mocks.workFindUnique.mockResolvedValue({
      ...base,
      runtimeKind: "pi-sdk",
      a2aActorId: "user-1",
      conversation: {
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        messages: [
          {
            id: "cmd",
            role: "user",
            parts: [{ type: "text", text: "/compact" }],
          },
        ],
      },
    });
    mocks.getAgentForRun.mockResolvedValue({
      id: "agent-1",
      runtimeKind: "pi-sdk",
      provider: { format: "openai" },
      model: "test",
      workspaceId: "workspace-1",
      piPackages: [],
    });
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: [],
      sandboxDeploymentIds: [],
      skills: [],
      subAgents: [],
    });
    mocks.runDedicatedSandboxTurn.mockResolvedValue("compacted");
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() =>
      expect(mocks.messageCreate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.runDedicatedSandboxTurn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/compact" }),
    );
  });
  it.each(["PI_PACKAGE_UNAVAILABLE", "AGENT_PROVIDER_REVOKED"])(
    "rejects live revision revocation before dispatch: %s",
    async (code) => {
      mocks.pinned.mockRejectedValue(new Error(code));
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      await vi.waitFor(() =>
        expect(mocks.workUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "failed", error: code }),
          }),
        ),
      );
      expect(mocks.runDedicatedSandboxTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ sandbox: null }, "Work sandbox is unavailable."],
    [{ runtimeKind: "unsupported" }, "Historical Work is read-only"],
  ])(
    "fails unavailable execution prerequisites without starting a runtime",
    async (override, error) => {
      const base = await mocks.workFindUnique();
      mocks.workFindUnique.mockResolvedValue({ ...base, ...override });
      // Reset modules per case so each coordinator owns fresh global state.
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      await vi.waitFor(() =>
        expect(mocks.workUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "failed",
              error: expect.stringContaining(error),
            }),
          }),
        ),
      );
    },
  );
  it("reconciles interrupted durable states once and stops only named Hermes runs", async () => {
    mocks.queued = false;
    const records = [
      { status: "running" },
      { status: "waiting_approval" },
      { status: "cancelling" },
      { status: "idle" },
    ];
    mocks.workFindMany.mockResolvedValue([
      {
        runtimeSnapshot: { hermesRunId: " interrupted-run " },
        agent: { id: "agent-1" },
      },
      { runtimeSnapshot: null, agent: { id: "agent-2" } },
      { runtimeSnapshot: [], agent: { id: "agent-3" } },
    ]);
    mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
      let count = 0;
      for (const record of records) {
        if (
          typeof where.status === "string"
            ? record.status !== where.status
            : !where.status.in.includes(record.status)
        )
          continue;
        Object.assign(record, data);
        count++;
      }
      return { count };
    });
    // Fresh module state is required to exercise startup reconciliation.
    const { startWorkCoordinator, stopWorkCoordinator } = await import(
      "@/lib/work/coordinator"
    );
    try {
      await startWorkCoordinator();
      await startWorkCoordinator();
      expect(records.map(({ status }) => status)).toEqual([
        "failed",
        "failed",
        "idle",
        "idle",
      ]);
      expect(mocks.stopHermesWorkRun).toHaveBeenCalledExactlyOnceWith({
        agent: { id: "agent-1" },
        runId: "interrupted-run",
      });
      expect(mocks.approvalUpdateMany).toHaveBeenCalledOnce();
      expect(mocks.approvalUpdateMany.mock.calls[0][0].data.status).toBe(
        "expired",
      );
    } finally {
      stopWorkCoordinator();
    }
  });
  it.each([
    { runtimeKind: "hermes" },
    { agentRevisionId: null, legacyRevisionUnresolved: true },
    {
      conversation: {
        agentRevisionId: "another-revision",
        legacyRevisionUnresolved: false,
        messages: [],
      },
    },
  ])("never executes retired or unresolved Work %#", async (override) => {
    const work = await mocks.workFindUnique();
    mocks.workFindUnique.mockResolvedValue({ ...work, ...override });
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() =>
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            error: expect.stringContaining("read-only"),
          }),
        }),
      ),
    );
    expect(mocks.pinned).not.toHaveBeenCalled();
    expect(mocks.runDedicatedSandboxTurn).not.toHaveBeenCalled();
  });

  it.each([null, "idle", "cancelling"])(
    "does not start a stale claimed session with current state %s",
    async (status) => {
      const work = await mocks.workFindUnique();
      mocks.workFindUnique.mockResolvedValue(
        status ? { ...work, status } : null,
      );
      // Fresh module state is required because the coordinator retains process globals.
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      // Match the freshly loaded coordinator's output registry after module reset.
      const { subscribeWorkOutput } = await import("@/lib/work/run-control");
      await vi.waitFor(() => {
        const output = subscribeWorkOutput("work-1", () => undefined);
        output.unsubscribe();
        expect(output.snapshot.done).toBe(true);
      });
      if (status === "cancelling")
        expect(mocks.workUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: "work-1",
              workspaceId: "workspace-1",
              status: "cancelling",
            },
            data: expect.objectContaining({ status: "idle" }),
          }),
        );
    },
  );

  it("persists dedicated runtime metadata and bounded reasoning without duplicate trace entries", async () => {
    const work = await mocks.workFindUnique();
    work.runtimeKind = "pi-sdk";
    work.conversation.messages[0].parts = [{ type: "text", text: "/clear" }];
    mocks.workFindUnique.mockResolvedValue(work);
    mocks.getAgentForRun.mockResolvedValue({
      id: "agent-1",
      runtimeKind: "pi-sdk",
      provider: { format: "openai" },
      model: "model",
      skills: [],
      piPackages: [],
      workspaceId: "workspace-1",
    });
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      options.onActivity({
        type: "reasoning",
        status: "completed",
        delta: "Detached thought",
      });
      options.onActivity({
        type: "reasoning",
        status: "running",
        delta: "x".repeat(40_001),
      });
      options.onActivity({ type: "reasoning", status: "completed" });
      options.onActivity({ type: "tool", status: "running" });
      options.onCommands([{ name: "clear", description: "Clear context" }]);
      options.onUsage({ tokens: 10 });
      options.onCommandResult({ command: "clear", text: "Cleared" });
      options.onContextUsage({
        usedTokens: 20,
        maxTokens: 100,
        modelName: "reported-model",
      });
      return "Cleared";
    });
    // Fresh module state is required because the coordinator retains process globals.
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledOnce());
    const parts = mocks.messageCreate.mock.calls[0][0].data.parts;
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          text: "Detached thought",
        }),
        expect.objectContaining({
          type: "data-context-usage",
          data: expect.objectContaining({ modelName: "reported-model" }),
        }),
        expect.objectContaining({
          type: "data-work-timing",
          data: expect.objectContaining({ modelName: "reported-model" }),
        }),
      ]),
    );
    const reasoning = parts.filter(
      (part: { type: string }) => part.type === "reasoning",
    );
    expect(reasoning.map((part: { text: string }) => part.text.length)).toEqual(
      [16, 40_000 - 16],
    );
    expect(
      parts.some((part: { type: string }) => part.type === "work-tool"),
    ).toBe(false);
    expect(mocks.generateWorkSessionTitle).not.toHaveBeenCalled();
  });

  it("persists allowlisted resource provenance and excludes resources added after session creation", async () => {
    const work = await mocks.workFindUnique();
    work.runtimeSnapshot = {
      ...work.runtimeSnapshot,
      deploymentIds: ["mcp"],
      installedSkillIds: ["skill"],
      knowledgeBaseIds: ["kb"],
    };
    mocks.workFindUnique.mockResolvedValue(work);
    mocks.resolveAgentTools.mockReturnValue({
      deploymentIds: ["mcp", "new-mcp", "sandbox"],
      sandboxDeploymentIds: ["sandbox"],
      skills: [{ id: "skill" }, { id: "new-skill" }, {}],
      knowledgeBases: [
        { knowledgeBase: { id: "kb" } },
        { knowledgeBase: { id: "new-kb" } },
      ],
      subAgents: [{ id: "child" }],
    });
    mocks.deploymentFindMany.mockResolvedValue([
      { id: "mcp", name: "Approved MCP", source: "npm", sourceRef: "approved" },
    ]);
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      options.onActivity({
        type: "tool",
        status: "running",
        toolCallId: "approved",
        toolName: "mcp__read_file",
        deploymentId: "mcp",
        originalToolName: "read_file",
        input: "file",
      });
      options.onActivity({
        type: "tool",
        status: "completed",
        toolCallId: "approved",
        toolName: "mcp__read_file",
        deploymentId: "mcp",
        originalToolName: "read_file",
        durationMs: 250,
      });
      options.onActivity({
        type: "tool",
        status: "completed",
        toolCallId: "unapproved",
        toolName: "new-mcp__read_file",
        durationMs: 0,
      });
      options.onActivity({
        type: "tool",
        status: "completed",
        toolCallId: "unnamed",
        toolName: "mcp__",
        durationMs: 0,
      });
      return "Inspected";
    });
    // Fresh module state is required because the coordinator retains process globals.
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledOnce());
    const parts = mocks.messageCreate.mock.calls[0][0].data.parts;
    expect(
      parts.find(
        (part: { toolName?: string }) => part.toolName === "mcp__read_file",
      ),
    ).toMatchObject({
      deploymentName: "Approved MCP",
      originalToolName: "read_file",
      durationMs: 250,
    });
    expect(
      parts.find(
        (part: { toolName?: string }) => part.toolName === "new-mcp__read_file",
      ),
    ).not.toHaveProperty("deploymentName");
    expect(
      parts.find((part: { toolName?: string }) => part.toolName === "mcp__"),
    ).not.toHaveProperty("originalToolName");
  });
  it("uses the pinned definition instead of mutable or copied model, step and system overrides", async () => {
    const work = await mocks.workFindUnique();
    work.runtimeSnapshot = {
      ...work.runtimeSnapshot,
      model: "unapproved",
      providerId: "unapproved",
      systemPrompt: "Unapproved instructions",
      agentMaxSteps: 999,
    };
    mocks.workFindUnique.mockResolvedValue(work);
    mocks.pinned.mockImplementation(async (agent) => ({
      ...agent,
      model: "approved-model",
      maxSteps: 3,
      systemPrompt: "Approved instructions",
      agentRevisionId: "revision-1",
    }));
    // Reload intentionally: the coordinator maintains process-local scheduling state.
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() =>
      expect(mocks.runDedicatedSandboxTurn).toHaveBeenCalledOnce(),
    );
    const options = mocks.runDedicatedSandboxTurn.mock.calls[0][0];
    expect(options.agent).toMatchObject({
      model: "approved-model",
      maxSteps: 3,
      agentRevisionId: "revision-1",
    });
    expect(options.systemPrompt).toContain("Approved instructions");
    expect(options.systemPrompt).not.toContain("Unapproved instructions");
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledOnce());
  });
  it("persists trusted prompt invocation against the original user row even if the native turn later fails", async () => {
    const work = await mocks.workFindUnique();
    work.conversation.messages[0].parts = [
      { type: "text", text: "/review src" },
    ];
    mocks.workFindUnique.mockResolvedValue(work);
    const invocation = {
      name: "review",
      source: {
        marketInstallId: "install",
        releaseId: "release",
        checksum: "a".repeat(64),
        path: "prompts/review.md",
      },
      version: "1.0.0",
      rawArguments: "src",
      arguments: ["src"],
      finalInput: "Review src",
    };
    mocks.prompt.mockResolvedValue(undefined);
    mocks.runDedicatedSandboxTurn.mockImplementation(async (options) => {
      await options.onPromptInvocation(invocation);
      throw new Error("native turn failed after prompt expansion");
    });
    // Reload intentionally: the coordinator maintains process-local scheduling state.
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    kickWorkCoordinator();
    await vi.waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith({
        conversationId: work.conversationId,
        messageId: "message-user",
        invocation,
      }),
    );
    expect(work.conversation.messages[0].parts).toEqual([
      { type: "text", text: "/review src" },
    ]);
    await vi.waitFor(() =>
      expect(
        mocks.workUpdateMany.mock.calls.some(
          ([call]) => call.data.status === "failed",
        ),
      ).toBe(true),
    );
  });
});
