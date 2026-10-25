import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { executeRuntimeCommand } from "@/lib/agents/runtime-command-service";
import { localOwnerKey } from "@/lib/a2a/local-policy";
import type * as LocalPolicy from "@/lib/a2a/local-policy";
import type * as EntryPolicy from "@/lib/a2a/entry-policy";
import type { LocalA2AGrant } from "@/lib/a2a/principal";

const mocks = vi.hoisted(() => ({
  db: {
    conversation: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    message: { create: vi.fn() },
    a2AEntryBinding: { findMany: vi.fn() },
    a2ATask: { count: vi.fn() },
  },
  agent: vi.fn(),
  turn: vi.fn(),
  work: vi.fn(),
  entry: vi.fn(),
  lock: vi.fn(),
  release: vi.fn(),
  actorPolicy: vi.fn(),
  entryPolicy: vi.fn(),
  resolvePinned: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agents/prompt-invocation", () => ({
  persistAgentPromptInvocation: mocks.prompt,
}));
vi.mock("@/lib/a2a/local-policy", async (original) => ({
  ...(await original<typeof LocalPolicy>()),
  assertLocalActor: mocks.actorPolicy,
}));
vi.mock("@/lib/a2a/entry-policy", async (original) => ({
  ...(await original<typeof EntryPolicy>()),
  assertEntryPolicy: mocks.entryPolicy,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));
vi.mock("@/lib/agents/revisions", () => ({
  resolvePinnedAgent: mocks.resolvePinned,
}));
vi.mock("@/lib/agents/sandbox-turn", () => ({
  runDedicatedSandboxTurn: mocks.turn,
}));
vi.mock("@/lib/work/sessions", () => ({ appendWorkSessionInput: mocks.work }));
vi.mock("@/lib/work/run-control", () => ({ startWorkOutput: vi.fn() }));
vi.mock("@/lib/work/coordinator", () => ({ kickWorkCoordinator: vi.fn() }));
vi.mock("@/lib/a2a/ingress", () => ({
  runNativeEntry: mocks.entry,
  nativeEntryResult: () => "native result",
  nativeEntryRuntimeParts: () => [],
}));
vi.mock("@/lib/agents/conversation-operations", () => ({
  acquireConversationOperation: mocks.lock,
  conversationOperationKey: (row: { id: string }) => row.id,
}));

const input = {
  workspaceId: "workspace",
  agentId: "agent",
  conversationId: "conversation",
  line: "/compact",
};
function fixture(kind = "pi-sdk") {
  const agent = {
    runtimeKind: kind,
    systemPrompt: "system",
    servers: [{ deploymentId: "server" }],
    skills: [],
    toolkits: [],
    sandboxes: [
      {
        sandboxId: "sandbox",
        isDefault: true,
        sandbox: { id: "sandbox", deploymentId: "sandbox-deployment" },
      },
    ],
  };
  const conversation = {
    id: "conversation",
    agentRevisionId: "session-revision" as string | null,
    legacyRevisionUnresolved: false,
    publicApiConversation: null as { id: string } | null,
    workSession: null as {
      id: string;
      runtimeKind: string;
      status: string;
    } | null,
    runtimeSessionKey: null as string | null,
    messages: [] as { role: string; parts: unknown }[],
  };
  mocks.agent.mockResolvedValue(agent);
  mocks.db.conversation.findFirst.mockResolvedValue(conversation);
  mocks.db.conversation.findUniqueOrThrow.mockResolvedValue(conversation);
  return { agent, conversation };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolvePinned.mockImplementation(async (agent, revisionId) => ({
    ...agent,
    agentRevisionId: revisionId,
  }));
  mocks.db.message.create.mockResolvedValue({ id: "command-user" });
  fixture();
  mocks.lock.mockReturnValue(mocks.release);
  mocks.turn.mockResolvedValue("output");
  mocks.db.a2AEntryBinding.findMany.mockResolvedValue([]);
});

describe("runtime command session admission", () => {
  it.each([
    "agent",
    "conversation",
    "public",
    "unresolved",
    "missing-pin",
    "legacy",
    "invalid",
    "long",
    "locked",
  ])("rejects %s before execution", async (condition) => {
    const { conversation } = fixture(
      condition === "legacy" ? "hermes" : "pi-sdk",
    );
    if (condition === "agent") mocks.agent.mockResolvedValue(null);
    if (condition === "conversation")
      mocks.db.conversation.findFirst.mockResolvedValue(null);
    if (condition === "public")
      conversation.publicApiConversation = { id: "public" };
    if (condition === "unresolved")
      conversation.legacyRevisionUnresolved = true;
    if (condition === "missing-pin") conversation.agentRevisionId = null;
    if (condition === "locked") mocks.lock.mockReturnValue(null);
    const line =
      condition === "invalid"
        ? "ordinary message"
        : condition === "long"
          ? `/compact ${"x".repeat(2000)}`
          : input.line;
    await expect(
      executeRuntimeCommand({ ...input, actorId: "actor", line }),
    ).rejects.toMatchObject({
      status: ["agent", "conversation", "public"].includes(condition)
        ? 404
        : ["invalid", "long"].includes(condition)
          ? 400
          : 409,
    });
    expect(mocks.entry).not.toHaveBeenCalled();
  });
  it("resolves the persisted session revision rather than a current revision", async () => {
    const { agent } = fixture();
    mocks.entry.mockResolvedValue({ task: {}, path: "native" });
    await expect(
      executeRuntimeCommand({ ...input, actorId: "actor" }),
    ).resolves.toEqual({ kind: "output", text: "native result" });
    expect(mocks.resolvePinned).toHaveBeenCalledWith(agent, "session-revision");
    expect(mocks.entry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent",
        sourceId: "conversation",
        actorId: "actor",
        text: "/compact",
      }),
    );
    expect(mocks.db.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation",
        role: "user",
        parts: [{ type: "text", text: "/compact" }],
      },
    });
    expect(mocks.db.message.create).toHaveBeenLastCalledWith({
      data: {
        conversationId: "conversation",
        role: "assistant",
        parts: [{ type: "text", text: "native result" }],
      },
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not dispatch when live revision authorization has been revoked", async () => {
    mocks.resolvePinned.mockRejectedValue(new Error("AGENT_GRANT_REVOKED"));
    await expect(
      executeRuntimeCommand({ ...input, actorId: "actor" }),
    ).rejects.toThrow("AGENT_GRANT_REVOKED");
    expect(mocks.entry).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "waiting_approval", "cancelling", "archived"])(
    "blocks %s work",
    async (status) => {
      const { conversation } = fixture();
      conversation.workSession = { id: "work", runtimeKind: "pi-sdk", status };
      await expect(
        executeRuntimeCommand({ ...input, actorId: "actor" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(mocks.entry).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it.each([true, false])(
    "queues waiting work only when it accepts the input: %s",
    async (ok) => {
      const { conversation } = fixture();
      conversation.workSession = {
        id: "work",
        runtimeKind: "pi-sdk",
        status: "waiting_input",
      };
      mocks.work.mockResolvedValue({ ok });
      const result = executeRuntimeCommand({ ...input, actorId: "actor" });
      if (ok)
        await expect(result).resolves.toEqual({
          kind: "queued",
          workSessionId: "work",
        });
      else await expect(result).rejects.toMatchObject({ status: 409 });
      expect(mocks.entry).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it("requires actor and channel message identities", async () => {
    await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      executeRuntimeCommand({
        ...input,
        actorId: "actor",
        entry: { kind: "channel", channelId: "channel" },
      }),
    ).rejects.toMatchObject({ message: "invalidCommand" });
    expect(mocks.entry).not.toHaveBeenCalled();
  });
  it.each(["missing", "failure", "unknown"])(
    "maps native failure %s",
    async (outcome) => {
      mocks.entry.mockRejectedValue(
        outcome === "missing"
          ? new TaskNotFoundError()
          : outcome === "failure"
            ? new Error("native failure")
            : "unknown",
      );
      await expect(
        executeRuntimeCommand({ ...input, actorId: "actor" }),
      ).rejects.toMatchObject({ status: outcome === "missing" ? 404 : 502 });
      expect(mocks.db.message.create).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it("persists trusted Prompt metadata before a later native failure without expanding the text again", async () => {
    const invocation = {
      name: "review",
      source: {
        marketInstallId: "install",
        releaseId: "release",
        checksum: "checksum",
        path: "prompts/review.md",
      },
      version: "release",
      rawArguments: "src",
      arguments: ["src"],
      finalInput: "Review src",
    };
    mocks.entry.mockImplementation(async (options) => {
      await options.onPromptInvocation(invocation);
      throw new Error("provider unavailable after expansion");
    });
    await expect(
      executeRuntimeCommand({
        ...input,
        line: "/review src",
        actorId: "actor",
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(mocks.prompt).toHaveBeenCalledWith({
      conversationId: "conversation",
      messageId: "command-user",
      invocation,
    });
    expect(mocks.entry).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/review src" }),
    );
    expect(mocks.db.message.create).toHaveBeenCalledTimes(1);
  });
});

describe("runtime command native binding ownership", () => {
  it.each([
    "no-actor",
    "remote",
    "actor",
    "workspace",
    "agent",
    "owner",
    "source",
    "kind",
    "context",
    "missing-policy",
    "duplicate",
    "active",
    "entry-kind",
    "entry-channel",
    "policy-missing",
    "policy-error",
    "success",
  ])("enforces binding constraint %s", async (condition) => {
    fixture("pi-sdk");
    const ownerKey = localOwnerKey(
      "entry",
      "workspace",
      "agent",
      "actor",
      "chat",
      "conversation",
    );
    const grant: LocalA2AGrant = {
      kind: "local",
      workspaceId: "workspace",
      agentId: "agent",
      agentRevisionId: "session-revision",
      actorId: "actor",
      targetBinding: "binding",
      ownerKey,
      expiresAt: 100,
      scopes: [],
      maxConcurrent: 1,
      timeoutSeconds: 60,
      retentionDays: 1,
      ancestorTaskIds: [],
      ancestorAgentIds: [],
      entryPolicy: {
        kind: "chat",
        sourceId: "conversation",
        sourceAgentId: "agent",
        binding: "binding",
      },
    };
    const binding = {
      ownerKey,
      kind: "chat",
      contextId: "context",
      lastTask: {
        grant: { ...grant, kind: condition === "remote" ? "remote" : "local" },
        contextId: "context",
        executionBackend: "pi-sdk",
      },
    };
    if (condition === "actor") binding.lastTask.grant.actorId = "foreign";
    if (condition === "workspace")
      binding.lastTask.grant.workspaceId = "foreign";
    if (condition === "agent") binding.lastTask.grant.agentId = "foreign";
    if (condition === "owner") binding.lastTask.grant.ownerKey = "foreign";
    if (condition === "source" && grant.entryPolicy)
      grant.entryPolicy.sourceId = "foreign";
    if (condition === "kind" && grant.entryPolicy)
      grant.entryPolicy.kind = "work";
    if (condition === "context") binding.lastTask.contextId = "foreign";
    if (condition === "missing-policy")
      binding.lastTask.grant.entryPolicy = undefined;
    mocks.db.a2AEntryBinding.findMany.mockResolvedValue(
      condition === "duplicate" ? [binding, binding] : [binding],
    );
    mocks.db.a2ATask.count.mockResolvedValue(condition === "active" ? 1 : 0);
    if (condition === "policy-missing")
      mocks.actorPolicy.mockRejectedValue(new TaskNotFoundError());
    if (condition === "policy-error")
      mocks.entryPolicy.mockRejectedValue(new Error("policy unavailable"));
    mocks.entry.mockResolvedValue({ task: {}, path: "native" });
    const pending = executeRuntimeCommand({
      ...input,
      ...(condition !== "no-actor" ? { actorId: "actor" } : {}),
      ...(condition === "entry-kind"
        ? { entry: { kind: "work" as const } }
        : {}),
      ...(condition === "entry-channel"
        ? { entry: { kind: "chat" as const, channelId: "foreign" } }
        : {}),
    });
    if (condition === "success")
      expect(await pending).toEqual({ kind: "output", text: "native result" });
    else if (condition === "policy-error")
      await expect(pending).rejects.toThrow("policy unavailable");
    else
      await expect(pending).rejects.toMatchObject({
        status: condition === "active" ? 409 : 404,
      });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
