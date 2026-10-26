import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { executeRuntimeCommand } from "@/lib/agents/runtime-command-service";
import type { RunDedicatedSandboxTurnInput } from "@/lib/agents/sandbox-turn";
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
  append: vi.fn(),
  work: vi.fn(),
  entry: vi.fn(),
  lock: vi.fn(),
  release: vi.fn(),
  actorPolicy: vi.fn(),
  entryPolicy: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/a2a/local-policy", async (original) => ({
  ...(await original<typeof LocalPolicy>()),
  assertLocalActor: mocks.actorPolicy,
}));
vi.mock("@/lib/a2a/entry-policy", async (original) => ({
  ...(await original<typeof EntryPolicy>()),
  assertEntryPolicy: mocks.entryPolicy,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));
vi.mock("@/lib/agents/sandbox-turn", () => ({
  runDedicatedSandboxTurn: mocks.turn,
}));
vi.mock("@/lib/agents/mutations", () => ({
  appendConversationTurn: mocks.append,
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
function fixture(kind = "claude-code") {
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
  fixture();
  mocks.lock.mockReturnValue(mocks.release);
  mocks.turn.mockResolvedValue("output");
  mocks.db.a2AEntryBinding.findMany.mockResolvedValue([]);
});

describe("runtime command service admission", () => {
  it.each([
    "agent",
    "conversation",
    "public",
    "runtime-changed",
    "invalid",
    "long",
    "unsupported",
    "locked",
  ])("rejects %s before executing", async (kind) => {
    const { conversation } = fixture();
    let line = input.line;
    if (kind === "agent") mocks.agent.mockResolvedValue(null);
    if (kind === "conversation")
      mocks.db.conversation.findFirst.mockResolvedValue(null);
    if (kind === "public")
      conversation.publicApiConversation = { id: "public" };
    if (kind === "runtime-changed")
      conversation.workSession = {
        id: "work",
        runtimeKind: "pi",
        status: "completed",
      };
    if (kind === "invalid") line = "ordinary message";
    if (kind === "long") line = `/compact ${"x".repeat(2000)}`;
    if (kind === "unsupported") line = "/unknown";
    if (kind === "locked") mocks.lock.mockReturnValue(null);
    await expect(
      executeRuntimeCommand({ ...input, line }),
    ).rejects.toMatchObject({
      status: ["agent", "conversation", "public"].includes(kind)
        ? 404
        : ["runtime-changed", "locked"].includes(kind)
          ? 409
          : 400,
    });
    expect(mocks.turn).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "waiting_approval", "cancelling", "archived"])(
    "blocks %s work and releases its command lease",
    async (status) => {
      const { conversation } = fixture();
      conversation.workSession = {
        id: "work",
        runtimeKind: "claude-code",
        status,
      };
      await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
        message: "busy",
        status: 409,
      });
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it.each([true, false])(
    "queues paused work only if the session accepts input: %s",
    async (ok) => {
      const { conversation } = fixture();
      conversation.workSession = {
        id: "work",
        runtimeKind: "claude-code",
        status: "waiting_input",
      };
      mocks.work.mockResolvedValue({ ok });
      if (ok)
        expect(await executeRuntimeCommand(input)).toEqual({
          kind: "queued",
          workSessionId: "work",
        });
      else
        await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
          message: "busy",
        });
      expect(mocks.turn).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
});

describe("runtime command output and failure policies", () => {
  it.each(["clear", "context", "usage", "compact"])(
    "stores /%s as command metadata rather than user dialogue",
    async (command) => {
      mocks.turn.mockImplementation(
        async (options: RunDedicatedSandboxTurnInput) => {
          options.onCommands?.([{ name: "context" }]);
          options.onUsage?.({
            inputTokens: 10,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
          return "output";
        },
      );
      expect(
        await executeRuntimeCommand({ ...input, line: `/${command}` }),
      ).toEqual({ kind: "output", text: "output" });
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.db.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: "assistant",
          textCharacters: 6,
          parts: expect.arrayContaining([
            { type: "data-command-result", data: { command, text: "output" } },
            {
              type: "data-runtime-usage",
              data: {
                inputTokens: 10,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          ]),
        }),
      });
      if (command === "clear")
        expect(
          mocks.db.message.create.mock.calls[0][0].data.parts,
        ).toContainEqual(
          expect.objectContaining({ type: "data-conversation-clear" }),
        );
    },
  );
  it.each(["", "pause", "clear", "build a website"])(
    "distinguishes dsh goal control from conversational input %j",
    async (args) => {
      fixture("dsh");
      await executeRuntimeCommand({ ...input, line: `/goal ${args}` });
      expect(mocks.append).toHaveBeenCalledTimes(
        args === "build a website" ? 1 : 0,
      );
      expect(mocks.db.message.create).toHaveBeenCalledTimes(
        args === "build a website" ? 0 : 1,
      );
    },
  );
  it.each([
    [new Error("PI_LANE_BUSY"), 409, "PI_LANE_BUSY"],
    [new Error("sandbox is busy"), 409, "sandbox is busy"],
    [new Error("offline"), 502, "offline"],
    ["failure", 502, "The runtime command failed."],
  ])("maps dedicated runtime failures", async (error, status, message) => {
    mocks.turn.mockRejectedValue(error);
    await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
      status,
      message,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.db.message.create).not.toHaveBeenCalled();
  });
  it("does not dispatch a fresh channel Pi session without native binding", async () => {
    const { conversation } = fixture("pi");
    conversation.runtimeSessionKey = "channel:connection:chat";
    await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
      message: "unsupportedCommand",
    });
  });
  it("requires SDK actor and channel message identities", async () => {
    fixture("pi-sdk");
    await expect(executeRuntimeCommand(input)).rejects.toMatchObject({
      message: "notFound",
    });
    await expect(
      executeRuntimeCommand({
        ...input,
        actorId: "actor",
        entry: { kind: "channel", channelId: "channel" },
      }),
    ).rejects.toMatchObject({ message: "invalidCommand" });
  });
  it.each(["success", "missing", "failure", "unknown"])(
    "maps SDK native entry outcome %s",
    async (outcome) => {
      fixture("pi-sdk");
      if (outcome === "missing")
        mocks.entry.mockRejectedValue(new TaskNotFoundError());
      else if (outcome === "failure")
        mocks.entry.mockRejectedValue(new Error("native failure"));
      else if (outcome === "unknown") mocks.entry.mockRejectedValue("unknown");
      else mocks.entry.mockResolvedValue({ task: {}, path: "native" });
      const result = executeRuntimeCommand({ ...input, actorId: "actor" });
      if (outcome === "success") {
        expect(await result).toEqual({ kind: "output", text: "native result" });
        expect(mocks.append).toHaveBeenCalledWith(
          "conversation",
          [{ type: "text", text: "/compact" }],
          [{ type: "text", text: "native result" }],
        );
      } else
        await expect(result).rejects.toMatchObject({
          status: outcome === "missing" ? 404 : 502,
        });
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
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
