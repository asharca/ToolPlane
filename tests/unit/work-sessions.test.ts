// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  agentFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  messageCreate: vi.fn(),
  workCreate: vi.fn(),
  workUpdateMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  workFindFirst: vi.fn(),
  pin: vi.fn(),
}));

const tx = {
  agent: { findFirst: mocks.agentFindFirst },
  conversation: {
    create: mocks.conversationCreate,
    update: mocks.conversationUpdate,
  },
  message: { create: mocks.messageCreate },
  workSession: {
    create: mocks.workCreate,
    updateMany: mocks.workUpdateMany,
    findFirst: mocks.workFindFirst,
  },
  workApproval: { updateMany: mocks.approvalUpdateMany },
  piSessionPackageSet: { create: vi.fn() },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workSession: {
      updateMany: mocks.workUpdateMany,
      findFirst: mocks.workFindFirst,
    },
  },
}));

vi.mock("@/lib/agents/mutations", () => ({
  defaultConversationRuntimeSession: (
    agentId: string,
    conversationId: string,
  ) => ({
    runtimeSessionId: conversationId,
    runtimeSessionKey: `agent:${agentId}:console:${conversationId}`,
  }),
}));
vi.mock("@/lib/agents/revisions", () => ({
  pinCurrentAgentRevision: mocks.pin,
}));

import {
  appendWorkSessionInput,
  cancelWorkSession,
  createWorkSession,
  finalizeWorkSessionCancellation,
  normalizeWorkDirectory,
  resumeWorkSession,
  transitionWorkSession,
  startWorkSession,
  failWorkSession,
  waitForWorkSessionUser,
  waitForWorkSessionApproval,
  archiveWorkSession,
  workSessionWorkingDirectory,
} from "@/lib/work/sessions";
import { canTransitionWorkSession } from "@/lib/work/state-machine";
const revisionConfig = {
  schemaVersion: 1,
  runtimeKind: "pi-sdk",
  systemPrompt: "Frozen instructions",
  providerId: "provider-1",
  model: "model-1",
  modelProviderIds: [],
  maxSteps: 8,
  disabledBuiltinTools: [],
  sandboxTemplateId: "sandbox-1",
  environment: {
    kind: "docker",
    image: `fixture@sha256:${"a".repeat(64)}`,
    network: "isolated",
    piVersion: "0.87.1",
    initialSnapshot: null,
    resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
    credentialReferences: [],
  },
  packages: [],
  mcpGrants: [],
  skills: [],
  knowledgeBaseIds: [],
  a2a: {
    inboundEnabled: false,
    outboundEnabled: false,
    policy: { schemaVersion: 1, targets: [] },
  },
};
function workRevisionIdentity() {
  return {
    agentId: "agent-1",
    agent: { runtimeKind: "pi-sdk", retiredAt: null },
    agentRevision: {
      id: "revision-1",
      agentId: "agent-1",
      config: revisionConfig,
    },
    conversation: {
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    },
    runtimeSnapshot: { providerId: "provider-1", model: "model-1" },
  };
}

describe("WorkSession coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.agentFindFirst.mockResolvedValue({
      id: "agent-1",
      providerId: "provider-1",
      model: "model-1",
      runtimeKind: "pi-sdk",
      systemPrompt: null,
      maxSteps: 8,
      servers: [],
      skills: [],
      toolkits: [],
      subAgents: [],
      knowledgeBases: [],
      piPackages: [],
      sandboxes: [
        {
          sandboxId: "sandbox-1",
          isDefault: true,
          sandbox: { kind: "docker", network: "isolated" },
        },
      ],
    });
    mocks.conversationCreate.mockResolvedValue({ id: "conversation-1" });
    mocks.conversationUpdate.mockResolvedValue({ id: "conversation-1" });
    mocks.messageCreate.mockResolvedValue({ id: "message-1" });
    mocks.workCreate.mockImplementation(async ({ data }) => ({
      id: "work-1",
      ...data,
    }));
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 });
    mocks.pin.mockResolvedValue({ id: "revision-1", config: revisionConfig });
    mocks.workFindFirst.mockResolvedValue({
      ...workRevisionIdentity(),
      conversationId: "conversation-1",
      status: "failed",
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
  });

  it("creates queued work and its first user message in one transaction", async () => {
    const work = await createWorkSession({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      sandboxId: "sandbox-1",
      task: "  Build and test it  ",
    });

    expect(work).toMatchObject({
      id: "work-1",
      status: "queued",
      task: "Build and test it",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation-1",
        role: "user",
        parts: [{ type: "text", text: "Build and test it" }],
        textCharacters: 17,
      },
    });
    expect(mocks.messageCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.workCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runtimeKind: "pi-sdk",
          runtimeSnapshot: expect.objectContaining({ workingDirectory: "." }),
        }),
      }),
    );
    expect(mocks.conversationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
      }),
    });
  });

  it.each(["pi", "hermes", "claude-code", "dsh", "hermes-rpc"])(
    "rejects retired %s execution before creating a Conversation",
    async (runtimeKind) => {
      const agent = await mocks.agentFindFirst();
      mocks.agentFindFirst.mockResolvedValue({ ...agent, runtimeKind });
      await expect(
        createWorkSession({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          task: "Build",
        }),
      ).resolves.toBeNull();
      expect(mocks.pin).not.toHaveBeenCalled();
      expect(mocks.conversationCreate).not.toHaveBeenCalled();
    },
  );

  it("normalizes sandbox working directories without allowing traversal", () => {
    expect(normalizeWorkDirectory("/workspace/projects/toolplane")).toBe(
      "projects/toolplane",
    );
    expect(
      normalizeWorkDirectory("/opt/data/workspace/projects/toolplane"),
    ).toBe("projects/toolplane");
    expect(normalizeWorkDirectory("projects/../app")).toBe("app");
    expect(normalizeWorkDirectory("../private")).toBeNull();
    expect(normalizeWorkDirectory("/etc")).toBeNull();
  });

  it("rejects an empty task before opening a transaction", async () => {
    await expect(
      createWorkSession({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        task: "   ",
      }),
    ).resolves.toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("moves a finished turn to idle without ending the session", async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      transitionWorkSession("workspace-1", "work-1", "idle", {
        result: "done",
      }),
    ).resolves.toEqual({ ok: true, changed: true, status: "idle" });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "work-1",
        workspaceId: "workspace-1",
        status: { in: ["queued", "running", "waiting_user", "cancelling"] },
      },
      data: { status: "idle", result: "done" },
    });

    mocks.workUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.workFindFirst.mockResolvedValueOnce({ status: "idle" });
    await expect(
      transitionWorkSession("workspace-1", "work-1", "idle", {
        result: "replacement",
      }),
    ).resolves.toEqual({ ok: true, changed: false, status: "idle" });
  });

  it("rejects illegal terminal transitions", async () => {
    expect(canTransitionWorkSession("completed", "running")).toBe(false);
    expect(canTransitionWorkSession("completed", "queued")).toBe(true);
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.workFindFirst.mockResolvedValueOnce({ status: "completed" });

    await expect(
      transitionWorkSession("workspace-1", "work-1", "running"),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_transition",
      status: "completed",
    });
  });

  it("atomically appends requested user input and requeues the work", async () => {
    mocks.workFindFirst.mockResolvedValueOnce({
      conversationId: "conversation-1",
      status: "waiting_user",
      ...workRevisionIdentity(),
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      appendWorkSessionInput("workspace-1", "work-1", "  Use PostgreSQL  ", {
        reasoningEffort: "high",
      }),
    ).resolves.toEqual({ ok: true, changed: true, status: "queued" });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "work-1",
        workspaceId: "workspace-1",
        status: "waiting_user",
      },
      data: {
        status: "queued",
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation-1",
        role: "user",
        parts: [{ type: "text", text: "Use PostgreSQL" }],
        textCharacters: 14,
      },
    });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { reasoningEffort: "high" },
    });
  });

  it("queues a fresh turn from idle", async () => {
    mocks.workFindFirst.mockResolvedValueOnce({
      conversationId: "conversation-1",
      status: "idle",
      ...workRevisionIdentity(),
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      appendWorkSessionInput("workspace-1", "work-1", "Do the next thing"),
    ).resolves.toEqual({ ok: true, changed: true, status: "queued" });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: { id: "work-1", workspaceId: "workspace-1", status: "idle" },
      data: {
        status: "queued",
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
  });

  it.each(["completed", "failed"] as const)(
    "accepts a new turn from pinned %s work",
    async (status) => {
      mocks.workFindFirst.mockResolvedValueOnce({
        conversationId: "conversation-1",
        status,
        ...workRevisionIdentity(),
        runtimeKind: "pi-sdk",
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
      });
      mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        appendWorkSessionInput("workspace-1", "work-1", "Continue working"),
      ).resolves.toEqual({ ok: true, changed: true, status: "queued" });
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "work-1", workspaceId: "workspace-1", status },
          data: expect.objectContaining({ status: "queued" }),
        }),
      );
    },
  );

  it("moves active work through cancelling before the runner confirms cancellation", async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(cancelWorkSession("workspace-1", "work-1")).resolves.toEqual({
      ok: true,
      changed: true,
      status: "cancelling",
    });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["running", "waiting_approval"] },
        }),
        data: expect.objectContaining({ status: "cancelling" }),
      }),
    );
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { workSessionId: "work-1", status: "pending" },
      data: { status: "expired", resolvedAt: expect.any(Date) },
    });
  });

  it("stops queued work at idle and finalizes an active cancellation at idle", async () => {
    mocks.workUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(cancelWorkSession("workspace-1", "work-1")).resolves.toEqual({
      ok: true,
      changed: true,
      status: "idle",
    });
    expect(mocks.workUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["queued", "waiting_user"] },
        }),
        data: expect.objectContaining({ status: "idle" }),
      }),
    );

    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      finalizeWorkSessionCancellation("workspace-1", "work-1"),
    ).resolves.toBe(true);
    expect(mocks.workUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: "work-1",
          workspaceId: "workspace-1",
          status: "cancelling",
        },
        data: expect.objectContaining({ status: "idle" }),
      }),
    );
  });

  it("requeues a failed task when it is explicitly resumed", async () => {
    mocks.workUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(resumeWorkSession("workspace-1", "work-1")).resolves.toEqual({
      ok: true,
      changed: true,
      status: "queued",
    });
    expect(mocks.workUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "work-1",
        workspaceId: "workspace-1",
        status: "failed",
        runtimeKind: "pi-sdk",
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        agent: { runtimeKind: "pi-sdk", retiredAt: null },
        conversation: {
          agentRevisionId: "revision-1",
          legacyRevisionUnresolved: false,
        },
      },
      data: {
        status: "queued",
        result: null,
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
  });
  it.each([
    "running",
    "waiting_approval",
    "queued",
    "waiting_user",
    "cancelling",
    "cancelled",
    "idle",
    "archived",
  ])("cancels only valid durable states from %s", async (initial) => {
    const record = {
      id: "work-1",
      workspaceId: "workspace-1",
      status: initial,
      error: "old",
      waitingQuestion: "old",
    };
    mocks.workFindFirst.mockImplementation(async ({ where }) =>
      where.id === record.id && where.workspaceId === record.workspaceId
        ? record
        : null,
    );
    mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.id !== record.id ||
        where.workspaceId !== record.workspaceId ||
        (typeof where.status === "string"
          ? record.status !== where.status
          : !where.status.in.includes(record.status))
      )
        return { count: 0 };
      Object.assign(record, data);
      return { count: 1 };
    });
    expect(await cancelWorkSession("other", "work-1")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(record.status).toBe(initial);
    const result = await cancelWorkSession("workspace-1", "work-1");
    if (["running", "waiting_approval"].includes(initial)) {
      expect(result).toEqual({ ok: true, changed: true, status: "cancelling" });
      expect(mocks.approvalUpdateMany).toHaveBeenCalledOnce();
      expect(await finalizeWorkSessionCancellation("other", "work-1")).toBe(
        false,
      );
      expect(
        await finalizeWorkSessionCancellation("workspace-1", "work-1"),
      ).toBe(true);
      expect(record).toMatchObject({
        status: "idle",
        error: null,
        waitingQuestion: null,
      });
    } else if (["queued", "waiting_user"].includes(initial)) {
      expect(result).toEqual({ ok: true, changed: true, status: "idle" });
      expect(record).toMatchObject({
        status: "idle",
        error: null,
        waitingQuestion: null,
      });
    } else if (["cancelling", "cancelled"].includes(initial)) {
      expect(result).toEqual({ ok: true, changed: false, status: initial });
    } else {
      expect(result).toEqual({
        ok: false,
        reason: "invalid_transition",
        status: initial,
      });
    }
  });

  it("runs start, user wait, resume, failure and archive transitions without leaking another owner's record", async () => {
    const record = {
      id: "work-1",
      workspaceId: "workspace-1",
      status: "queued",
      ...workRevisionIdentity(),
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
      error: "old",
      waitingQuestion: "old",
      result: "old",
      cancelRequestedAt: new Date(),
    };
    mocks.workFindFirst.mockImplementation(async ({ where }) =>
      where.workspaceId === record.workspaceId ? record : null,
    );
    mocks.workUpdateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.workspaceId !== record.workspaceId ||
        (typeof where.status === "string"
          ? record.status !== where.status
          : !where.status.in.includes(record.status))
      )
        return { count: 0 };
      Object.assign(record, data);
      return { count: 1 };
    });
    expect(await startWorkSession("workspace-1", "work-1")).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await startWorkSession("workspace-1", "work-1")).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(
      await waitForWorkSessionUser(
        "workspace-1",
        "work-1",
        "  Which account?  ",
      ),
    ).toMatchObject({ ok: true });
    expect(record.waitingQuestion).toBe("Which account?");
    expect(
      await waitForWorkSessionApproval("workspace-1", "work-1"),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await resumeWorkSession("other", "work-1")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await resumeWorkSession("workspace-1", "work-1")).toMatchObject({
      ok: false,
      reason: "invalid_transition",
    });
    expect(await failWorkSession("workspace-1", "work-1", " ")).toMatchObject({
      ok: true,
    });
    expect(record.error).toBe("Work failed.");
    expect(
      await resumeWorkSession("workspace-1", "work-1", "new-actor"),
    ).toMatchObject({ ok: true });
    expect(record).toMatchObject({
      status: "queued",
      error: null,
      waitingQuestion: null,
      result: null,
      cancelRequestedAt: null,
      a2aActorId: "new-actor",
    });
    await startWorkSession("workspace-1", "work-1");
    await waitForWorkSessionApproval("workspace-1", "work-1");
    await failWorkSession("workspace-1", "work-1", "x".repeat(600));
    expect(record.error?.length).toBe(500);
    expect(await archiveWorkSession("other", "work-1")).toBe(false);
    expect(await archiveWorkSession("workspace-1", "work-1")).toBe(true);
    expect(record.status).toBe("archived");
  });

  it.each(["", " ", "x".repeat(20_001)])(
    "rejects unbounded or blank appended input %#",
    async (input) => {
      expect(
        await appendWorkSessionInput("workspace-1", "work-1", input),
      ).toEqual({ ok: false, reason: "invalid_input" });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects a concurrent append claim without creating duplicate messages", async () => {
    mocks.workFindFirst.mockResolvedValue({
      conversationId: "conversation-1",
      status: "waiting_user",
      ...workRevisionIdentity(),
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    mocks.workUpdateMany.mockResolvedValue({ count: 0 });
    expect(
      await appendWorkSessionInput("workspace-1", "work-1", "Answer"),
    ).toEqual({
      ok: false,
      reason: "invalid_transition",
      status: "waiting_user",
    });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    "invalid",
    { workingDirectory: "/etc" },
    { workingDirectory: "../escape" },
    { workingDirectory: "project" },
  ])("normalizes persisted working-directory snapshots %#", (snapshot) => {
    expect(workSessionWorkingDirectory(snapshot)).toBe(
      snapshot &&
        !Array.isArray(snapshot) &&
        typeof snapshot === "object" &&
        snapshot.workingDirectory === "project"
        ? "project"
        : ".",
    );
  });
  it.each([
    "wrong-sandbox",
    "read-only",
    "wrong-kind",
    "offline",
    "multiple",
    "unsupported",
  ])(
    "refuses unsafe dedicated sandbox assignment %s before persisting conversation state",
    async (condition) => {
      const agent = await mocks.agentFindFirst();
      if (condition === "wrong-sandbox")
        agent.sandboxes[0].sandboxId = "different";
      if (condition === "read-only")
        agent.sandboxes[0].sandbox.config = { readOnly: true };
      if (condition === "wrong-kind") agent.sandboxes[0].sandbox.kind = "host";
      if (condition === "offline") agent.sandboxes[0].sandbox.network = "none";
      if (condition === "multiple")
        agent.sandboxes.push({ ...agent.sandboxes[0], sandboxId: "second" });
      if (condition === "unsupported") agent.runtimeKind = "unknown";
      mocks.agentFindFirst.mockResolvedValue(agent);
      expect(
        await createWorkSession({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          sandboxId: "sandbox-1",
          task: "Build",
        }),
      ).toBeNull();
      expect(mocks.conversationCreate).not.toHaveBeenCalled();
      expect(mocks.messageCreate).not.toHaveBeenCalled();
    },
  );

  it.each([null, "revision-1"])(
    "keeps unresolved historical input read-only (%s)",
    async (agentRevisionId) => {
      mocks.workFindFirst.mockResolvedValue({
        conversationId: "history",
        status: "completed",
        runtimeKind: "pi-sdk",
        agentRevisionId,
        legacyRevisionUnresolved: true,
      });
      await expect(
        appendWorkSessionInput("workspace-1", "work-1", "Resume history"),
      ).resolves.toEqual({
        ok: false,
        reason: "invalid_transition",
        status: "completed",
      });
      expect(mocks.messageCreate).not.toHaveBeenCalled();
      expect(mocks.pin).not.toHaveBeenCalled();
    },
  );

  it("snapshots only the published revision resources, not newly attached Toolkit resources", async () => {
    const agent = await mocks.agentFindFirst();
    agent.servers = [{ deploymentId: "direct" }];
    agent.skills = [{ installedSkillId: "direct-skill" }];
    agent.toolkits = [
      {
        toolkit: {
          servers: [{ deploymentId: "direct" }, { deploymentId: "toolkit" }],
          skills: [
            { installedSkillId: "direct-skill" },
            { installedSkillId: "toolkit-skill" },
          ],
        },
      },
    ];
    agent.knowledgeBases = [{ knowledgeBaseId: "knowledge" }];
    mocks.agentFindFirst.mockResolvedValue(agent);
    const revision = await mocks.pin();
    mocks.pin.mockResolvedValue({
      ...revision,
      config: {
        ...revision.config,
        mcpGrants: [{ deploymentId: "direct" }],
        skills: [{ installedSkillId: "direct-skill" }],
        knowledgeBaseIds: ["knowledge"],
      },
    });
    const work = await createWorkSession({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      task: "Build",
      acceptanceCriteria: "  Tests pass  ",
      workingDirectory: "/workspace/project",
      reasoningEffort: "default",
    });
    expect(work).toMatchObject({
      acceptanceCriteria: "Tests pass",
      runtimeSnapshot: {
        deploymentIds: ["direct"],
        installedSkillIds: ["direct-skill"],
        knowledgeBaseIds: ["knowledge"],
        workingDirectory: "project",
      },
    });
    expect(mocks.conversationCreate.mock.calls[0][0].data).not.toHaveProperty(
      "reasoningEffort",
    );
  });
});
