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
  runHermesWork: vi.fn(),
  effectiveStatus: vi.fn(),
  releaseLease: vi.fn(),
  generateWorkSessionTitle: vi.fn(),
  approvalCreate: vi.fn(),
  approvalFindUnique: vi.fn(),
  approvalUpdateMany: vi.fn(),
  stopHermesWorkRun: vi.fn(),
  runtimeSession: vi.fn(),
  leaseAvailable: true,
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
vi.mock("@/lib/agents/run", () => ({ buildAgentToolSet: vi.fn() }));
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
vi.mock("@/lib/agents/hermes/work", () => ({
  runHermesWork: mocks.runHermesWork,
  stopHermesWorkRun: mocks.stopHermesWorkRun,
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  acquireHermesRuntimeWriteLease: () =>
    mocks.leaseAvailable ? { release: mocks.releaseLease } : null,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: "Hermes maintenance in progress.",
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
    mocks.leaseAvailable = true;
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
      sandboxId: "sandbox-hermes",
      conversationId: "conversation-1",
      task: "Inspect the repository",
      runtimeKind: "hermes",
      runtimeSnapshot: {
        runtimeId: "runtime-1",
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
        hermesProfile: "research",
        hermesProvider: "openrouter",
        hermesModel: "model-a",
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
      runtimeKind: "hermes",
      runtime: { id: "runtime-1", kind: "hermes", sandboxId: "sandbox-hermes" },
      provider: null,
      model: null,
      modelProviders: [{ providerId: "provider-1" }],
      systemPrompt: null,
      maxSteps: 12,
      servers: [],
      skills: [],
      toolkits: [],
      sandboxes: [],
    });
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onRunStarted?.("run-1");
      await options.onReasoningAvailable?.({
        runId: "run-1",
        timestamp: 1,
        text: "Inspecting files",
      });
      await options.onToolStarted?.({
        runId: "run-1",
        timestamp: 2,
        tool: "terminal",
        preview: "pnpm test",
      });
      await options.onMessageDelta?.({
        runId: "run-1",
        timestamp: 3,
        delta: "Done",
      });
      await options.onToolCompleted?.({
        runId: "run-1",
        timestamp: 4,
        tool: "terminal",
        duration: 1.2,
        error: false,
      });
      return { runId: "run-1", status: "completed", text: "Done" };
    });
  });

  it("streams Hermes activity and persists the completed Work turn", async () => {
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    const { subscribeWorkOutput } = await import("@/lib/work/run-control");
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput(
      "work-1",
      () => undefined,
    );
    expect(snapshot).toMatchObject({ text: "Done", done: true });
    expect(snapshot.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          text: "Inspecting files\n",
          status: "completed",
        }),
        expect.objectContaining({
          type: "tool",
          toolName: "terminal",
          status: "completed",
          durationMs: 1200,
        }),
        expect.objectContaining({
          type: "runtime",
          runtimeKind: "hermes",
          status: "completed",
        }),
      ]),
    );
    expect(
      snapshot.activities.find((activity) => activity.toolName === "terminal")
        ?.durationMs,
    ).toBe(1200);
    unsubscribe();
    expect(mocks.runHermesWork).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Inspect the repository",
        workingDirectory: ".",
        sessionId: "conversation-1",
        profile: "research",
        provider: "openrouter",
        model: "model-a",
        reasoningEffort: "high",
      }),
    );
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        role: "assistant",
        textCharacters: 4,
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            text: "Inspecting files\n",
          }),
          expect.objectContaining({
            type: "work-tool",
            toolName: "terminal",
            status: "completed",
            durationMs: 1200,
          }),
          { type: "text", text: "Done", state: "done" },
          expect.objectContaining({
            type: "data-work-timing",
            data: expect.objectContaining({
              runtimeKind: "hermes",
              modelName: "model-a",
              startedAt: expect.any(Number),
              completedAt: expect.any(Number),
              durationMs: expect.any(Number),
            }),
          }),
        ]),
      }),
    });
    expect(mocks.generateWorkSessionTitle).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
      "conversation-1",
    );
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "work-1", status: "running" },
        data: expect.objectContaining({ status: "idle" }),
      }),
    );
  });

  it("keeps live activity order when the runtime fails", async () => {
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onReasoningAvailable?.({
        runId: "run-1",
        timestamp: 1,
        text: "Inspecting files",
      });
      await options.onToolStarted?.({
        runId: "run-1",
        timestamp: 2,
        tool: "terminal",
        preview: "pnpm test",
      });
      await options.onToolCompleted?.({
        runId: "run-1",
        timestamp: 3,
        tool: "terminal",
        duration: 1.2,
        error: false,
      });
      return {
        runId: "run-1",
        status: "failed",
        text: "",
        error: "Runtime stopped",
      };
    });

    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    const { subscribeWorkOutput } = await import("@/lib/work/run-control");
    kickWorkCoordinator();

    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalled());
    const { snapshot, unsubscribe } = subscribeWorkOutput(
      "work-1",
      () => undefined,
    );
    expect(
      snapshot.activities.map(({ id, type, status }) => ({ id, type, status })),
    ).toEqual([
      { id: "runtime", type: "runtime", status: "running" },
      { id: "reasoning:1", type: "reasoning", status: "completed" },
      { id: "tool:hermes:run-1:tool:1", type: "tool", status: "completed" },
      { id: "runtime:final", type: "runtime", status: "failed" },
    ]);
    unsubscribe();
  });

  it.each(["hermes", "dsh"])(
    "finishes %s Work and releases its slot before the title is generated",
    async (runtimeKind) => {
      if (runtimeKind === "dsh") {
        const work = await mocks.workFindUnique();
        const agent = await mocks.getAgentForRun();
        mocks.workFindUnique.mockResolvedValue({
          ...work,
          runtimeKind,
          a2aActorId: "user-1",
        });
        mocks.getAgentForRun.mockResolvedValue({
          ...agent,
          runtimeKind,
          provider: { id: "provider-1" },
          model: "model-a",
        });
        mocks.runDedicatedSandboxTurn.mockResolvedValue("Done");
      }
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
    },
  );

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

  it("labels Hermes MCP tools with the workspace deployment and original name", async () => {
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
    mocks.runHermesWork.mockImplementation(async (options) => {
      await options.onToolStarted?.({
        runId: "run-1",
        timestamp: 1,
        tool: "dep-mcp__read/file",
        preview: "README.md",
      });
      await options.onToolCompleted?.({
        runId: "run-1",
        timestamp: 2,
        tool: "dep-mcp__read/file",
        duration: 0.2,
        error: false,
      });
      return { runId: "run-1", status: "completed", text: "Done" };
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

  it.each(["pi", "claude-code", "dsh", "hermes-rpc"])(
    "streams %s through the legacy sandbox runner with text deltas",
    async (runtimeKind) => {
      mocks.workFindUnique.mockResolvedValue({
        id: "work-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        a2aActorId: "user-1",
        sandboxId: "sandbox-1",
        conversationId: "conversation-1",
        task: "Original task",
        runtimeKind,
        runtimeSnapshot: {
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
          sandboxId: "sandbox-1",
          runtimeSessionId: "conversation-1",
          workingDirectory: "src",
        }),
      );
      expect(mocks.runNativeEntry).not.toHaveBeenCalled();
      expect(mocks.runHermesWork).not.toHaveBeenCalled();
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
      runtimeKind: "pi",
      a2aActorId: "user-1",
      conversation: {
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
      runtimeKind: "pi",
      provider: { format: "openai" },
      model: "test",
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
  it.each(["allowed", "denied", "expired", null])(
    "resumes Hermes after approval decision %s without losing durable state",
    async (decision) => {
      let status = "queued";
      const transitions: string[] = [];
      mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
        const matches =
          typeof where.status === "string"
            ? status === where.status
            : (where.status?.in?.includes(status) ?? true);
        if (!matches) return { count: 0 };
        if (data.status) {
          status = data.status;
          transitions.push(status);
          if (status === "running") mocks.queued = false;
        }
        return { count: 1 };
      });
      mocks.approvalCreate.mockResolvedValue({ id: "approval-1" });
      mocks.approvalFindUnique.mockResolvedValue(
        decision ? { status: decision } : null,
      );
      mocks.runHermesWork.mockImplementation(async (options) => {
        expect(status).toBe("running");
        const result = await options.onApproval({
          runId: "run",
          command: "rm temporary-file",
          description: "Remove temporary output",
          patternKeys: [],
          choices: [],
        });
        expect(result).toBe(decision === "allowed" ? "allow" : "deny");
        expect(status).toBe("running");
        return { runId: "run", status: "completed", text: "Decision recorded" };
      });
      // Reset modules per case so each coordinator owns fresh global state.
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      await vi.waitFor(() => expect(status).toBe("idle"));
      expect(transitions).toEqual([
        "running",
        "waiting_approval",
        "running",
        "idle",
      ]);
      expect(mocks.approvalCreate.mock.calls[0][0].data).toMatchObject({
        workSessionId: "work-1",
        toolName: "Hermes command",
      });
      expect(mocks.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it.each(["failed", "cancelled"])(
    "persists failed Hermes runtime outcome %s and releases the lease",
    async (status) => {
      mocks.runHermesWork.mockResolvedValue({
        runId: "run",
        status,
        text: "",
        error: "upstream failed",
      });
      // Reset modules per case so each coordinator owns fresh global state.
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      await vi.waitFor(() =>
        expect(mocks.workUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "failed",
              error:
                status === "failed"
                  ? "upstream failed"
                  : "Hermes run was cancelled.",
            }),
          }),
        ),
      );
      expect(mocks.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it("correlates subagent activity and settles unfinished tool activity", async () => {
    mocks.runHermesWork.mockImplementation(async (options) => {
      options.onSubagent({
        event: "subagent.start",
        runId: "run",
        childSessionId: "child",
        goal: "Inspect",
      });
      options.onSubagent({
        event: "subagent.complete",
        runId: "run",
        childSessionId: "child",
        status: "failed",
        summary: "Permission denied",
      });
      options.onSubagent({
        event: "subagent.complete",
        runId: "run",
        taskIndex: 2,
        status: "completed",
        outputTail: "Recovered",
      });
      options.onToolStarted({ runId: "run", tool: "unfinished" });
      options.onToolCompleted({
        runId: "run",
        tool: "orphan",
        duration: 0,
        error: true,
      });
      return { runId: "run", status: "completed", text: "Completed" };
    });
    // Reset modules per case so each coordinator owns fresh global state.
    const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
    const { subscribeWorkOutput } = await import("@/lib/work/run-control");
    kickWorkCoordinator();
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledOnce());
    const { snapshot, unsubscribe } = subscribeWorkOutput(
      "work-1",
      () => undefined,
    );
    expect(snapshot.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "delegate_task",
          status: "failed",
          isError: true,
        }),
        expect.objectContaining({
          toolName: "delegate_task",
          status: "completed",
        }),
        expect.objectContaining({ toolName: "unfinished", status: "failed" }),
        expect.objectContaining({ toolName: "orphan", status: "failed" }),
      ]),
    );
    unsubscribe();
  });

  it.each([
    [{ sandbox: null }, "Work sandbox is unavailable."],
    [{ runtimeKind: "unsupported" }, "Unsupported Work runtime"],
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
      expect(mocks.runHermesWork).not.toHaveBeenCalled();
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
    ["changed-runtime", "The Agent runtime changed"],
    ["changed-sandbox", "The Hermes runtime sandbox changed"],
    ["changed-id", "The Hermes runtime sandbox changed"],
    ["no-model-provider", "no configured model provider"],
    ["no-conversation", "conversation no longer exists"],
    ["maintenance", "maintenance in progress"],
    ["stopped-sandbox", "sandbox is not running"],
    ["no-model", "no configured model"],
  ])(
    "fails safely when runtime prerequisite %s changes",
    async (change, message) => {
      const work = await mocks.workFindUnique();
      const agent = await mocks.getAgentForRun();
      if (change === "changed-runtime") agent.runtimeKind = "pi";
      if (change === "changed-sandbox") agent.runtime.sandboxId = "replacement";
      if (change === "changed-id") agent.runtime.id = "replacement";
      if (change === "no-model-provider") agent.modelProviders = [];
      if (change === "no-conversation")
        mocks.runtimeSession.mockResolvedValue(null);
      if (change === "maintenance") mocks.leaseAvailable = false;
      if (change === "stopped-sandbox" || change === "no-model") {
        work.runtimeKind = "pi";
        agent.runtimeKind = "pi";
        if (change === "stopped-sandbox")
          mocks.effectiveStatus.mockReturnValue("stopped");
      }
      mocks.workFindUnique.mockResolvedValue(work);
      mocks.getAgentForRun.mockResolvedValue(agent);
      // Fresh module state is required because the coordinator retains process globals.
      const { kickWorkCoordinator } = await import("@/lib/work/coordinator");
      kickWorkCoordinator();
      await vi.waitFor(() =>
        expect(mocks.workUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "failed",
              error: expect.stringContaining(message),
            }),
          }),
        ),
      );
      expect(mocks.runHermesWork).not.toHaveBeenCalled();
      expect(mocks.runDedicatedSandboxTurn).not.toHaveBeenCalled();
    },
  );

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
      expect(mocks.runHermesWork).not.toHaveBeenCalled();
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
    work.runtimeKind = "claude-code";
    work.conversation.messages[0].parts = [{ type: "text", text: "/clear" }];
    mocks.workFindUnique.mockResolvedValue(work);
    mocks.getAgentForRun.mockResolvedValue({
      id: "agent-1",
      runtimeKind: "claude-code",
      provider: { format: "openai" },
      model: "model",
      skills: [],
      piPackages: [],
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
    mocks.runHermesWork.mockImplementation(async (options) => {
      options.onToolStarted({
        runId: "run",
        tool: "mcp__read_file",
        preview: "file",
      });
      options.onToolCompleted({
        runId: "run",
        tool: "mcp__read_file",
        duration: 0.25,
        error: false,
      });
      options.onToolStarted({ runId: "run", tool: "new-mcp__read_file" });
      options.onToolCompleted({
        runId: "run",
        tool: "new-mcp__read_file",
        duration: 0,
        error: false,
      });
      options.onToolStarted({ runId: "run", tool: "mcp__" });
      options.onToolCompleted({
        runId: "run",
        tool: "mcp__",
        duration: 0,
        error: false,
      });
      return { status: "completed", text: "Inspected" };
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
});
