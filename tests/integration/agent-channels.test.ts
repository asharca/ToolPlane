// @vitest-environment node
import { assertDefined } from "../assert-defined";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { Task, TaskState } from "@a2a-js/sdk";
import { runNativeEntry } from "@/lib/a2a/ingress";
import { claimTask, finishTask, getTask } from "@/lib/a2a/store";
import { textArtifact } from "@/lib/a2a/model";
import { db } from "@/lib/db";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { GET, POST } from "@/app/api/v1/workspaces/[slug]/agent-channels/route";
import {
  createAgentChannelConnection,
  decryptChannelCredentials,
} from "@/lib/agents/channel-connections";
import {
  runAgentChannelMessage,
  runWorkspaceAgentMessage,
} from "@/lib/agents/message-service";
import {
  liveAgentChannelStatus,
  startAgentChannelRunner,
  stopAgentChannelRunner,
} from "@/lib/agents/channel-runtime";
import { acquireConversationOperation } from "@/lib/agents/conversation-operations";
import { POST as runtimeCommand } from "@/app/api/v1/agents/[agentId]/conversations/[conversationId]/commands/route";
import { executeRuntimeCommand } from "@/lib/agents/runtime-command-service";

const identity = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: async () => identity.user,
  resolveRequestUser: async () => identity.user,
}));
vi.mock("@/lib/agents/channel-runtime", () => ({
  liveAgentChannelStatus: vi.fn(() => "stopped"),
  startAgentChannelRunner: vi.fn(async () => ({
    error: "Runner is not configured",
  })),
  stopAgentChannelRunner: vi.fn(async () => {}),
}));
// Keep real published-revision admission, policy, persistence and receipts;
// inject only terminal SDK output, without legacy Harness operation metadata.
vi.mock("@/lib/a2a/ingress", async (original) => {
  const actual = await original<typeof import("@/lib/a2a/ingress")>();
  return {
    ...actual,
    runNativeEntry: vi.fn(
      async (input: Parameters<typeof actual.runNativeEntry>[0]) => {
        const accepted = await actual.submitNativeEntry(input, () => {});
        const path = `/app/channels/agents/${input.agentId}?settings=a2a&task=${accepted.row.id}`;
        await input.onAccepted?.(Task.fromJSON(accepted.row.snapshot), path);
        if (!accepted.replay) {
          const running = await claimTask(accepted.row.id);
          if (!running?.leaseToken)
            throw new Error("Native fixture task was not claimed.");
          expect(running.executionBackend).toBe("pi-sdk");
          const context = await db.a2AContext.findUniqueOrThrow({
            where: { id: running.contextId },
          });
          const revision = await db.agentRevision.findUniqueOrThrow({
            where: { id: assertDefined(context.agentRevisionId) },
          });
          expect(revision.agentId).toBe(input.agentId);
          await finishTask(
            running.id,
            running.leaseToken,
            TaskState.TASK_STATE_COMPLETED,
            undefined,
            textArtifact("Channel reply"),
          );
        }
        return { task: await getTask(accepted.grant, accepted.row.id), path };
      },
    ),
  };
});

let workspace: { id: string; slug: string };
let other: { id: string; slug: string };
let agentId: string;
let foreignAgentId: string;
let providerId: string;
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `channel-ui-${Date.now()}@test.dev`,
      passwordHash: "unused",
    },
  });
  identity.user = user;
  workspace = await db.workspace.create({
    data: {
      slug: `channel-ui-${Date.now()}`,
      name: "Channels",
      ownerId: user.id,
    },
  });
  other = await db.workspace.create({
    data: {
      slug: `channel-other-${Date.now()}`,
      name: "Other",
      ownerId: user.id,
    },
  });
  const provider = await db.modelProvider.create({
    data: {
      workspaceId: workspace.id,
      name: "Test",
      format: "openai",
      baseUrl: "https://example.invalid",
      apiKey: "unused",
      models: ["test"],
    },
  });
  providerId = provider.id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: "Bound agent",
        slug: "bound-agent",
        runtimeKind: "pi-sdk",
        providerId: provider.id,
        model: "test",
      },
    })
  ).id;
  foreignAgentId = (
    await db.agent.create({
      data: {
        workspaceId: other.id,
        name: "Other agent",
        slug: "other-agent",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(liveAgentChannelStatus).mockReturnValue("stopped");
  vi.mocked(startAgentChannelRunner).mockResolvedValue({
    error: "Runner is not configured",
  });
});
afterAll(async () => {
  await db.logEvent.deleteMany({
    where: { workspaceId: { in: [workspace.id, other.id] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [workspace.id, other.id] } },
  });
  await db.user.delete({ where: { id: assertDefined(identity.user).id } });
  await db.$disconnect();
});
async function command(body: Record<string, unknown>, slug = workspace.slug) {
  return POST(
    new Request(`http://localhost/api/v1/workspaces/${slug}/agent-channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}
async function createSandbox(workspaceId: string, name: string) {
  const deployment = await db.deployment.create({
    data: { workspaceId, name, status: "stopped" },
  });
  return db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      kind: "docker",
      network: "isolated",
    },
  });
}

async function enableNativeAgent(id: string, sandboxId?: string) {
  const existing = await db.agentSandbox.findFirst({
    where: { agentId: id, isDefault: true },
  });
  if (!sandboxId && !existing) {
    const sandbox = await createSandbox(workspace.id, `Native ${id}`);
    await db.agentSandbox.create({
      data: { agentId: id, sandboxId: sandbox.id, isDefault: true },
    });
  }
  await db.agent.update({
    where: { id },
    data: { a2aInternalEnabled: false, a2aInboundEnabled: true },
  });
  await publishFixtureAgentRevision(workspace.id, id);
}
async function nativeBinding(conversationId: string) {
  return db.a2AEntryBinding.findFirstOrThrow({
    where: { kind: "channel", sourceId: conversationId },
    include: { lastTask: true, context: true },
  });
}
async function piCommandChannel() {
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      slug: `pi-commands-${randomUUID()}`,
      name: "Pi commands",
      runtimeKind: "pi-sdk",
      providerId,
      model: "test",
    },
  });
  await enableNativeAgent(agent.id);
  const channel = assertDefined(
    (
      await createAgentChannelConnection({
        workspaceId: workspace.id,
        agentId: agent.id,
        platform: "weixin",
        name: "Pi commands",
        credentials: {},
      })
    ).connection,
  );
  await db.agentChannelConnection.update({
    where: { id: channel.id },
    data: { status: "running", a2aActorId: assertDefined(identity.user).id },
  });
  const run = (message: string) =>
    runAgentChannelMessage({
      workspaceId: workspace.id,
      connectionId: channel.id,
      agentId: agent.id,
      rawBody: {
        message,
        source: {
          chatId: "pi-commands-user",
          userId: "external-sender-not-platform-actor",
          messageId: randomUUID(),
        },
      },
    });
  return { agent, channel, run };
}

describe("workspace channels", () => {
  it("keeps SDK control-message slash input executable instead of wrapping it in messaging context", async () => {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        slug: `sdk-control-${randomUUID()}`,
        name: "SDK control",
        runtimeKind: "pi-sdk",
        providerId,
        model: "test",
      },
    });
    await enableNativeAgent(agent.id);
    const result = await runWorkspaceAgentMessage({
      workspaceId: workspace.id,
      agentId: agent.id,
      userId: assertDefined(identity.user).id,
      rawBody: {
        message: "/Review:1 Keep Case",
        source: {
          platform: "mcp",
          chatId: "control-client",
          messageId: randomUUID(),
        },
      },
    });
    expect(result.status).toBe(200);
    if (!("conversationId" in result.body))
      throw new Error("Missing SDK control conversation");
    const binding = await db.a2AEntryBinding.findFirstOrThrow({
      where: { kind: "control", sourceId: result.body.conversationId },
      include: { lastTask: true },
    });
    const task = Task.fromJSON(binding.lastTask.snapshot);
    expect(task.history[0]?.parts[0]?.content).toEqual({
      $case: "text",
      value: "/Review:1 Keep Case",
    });
  });

  it("admits first SDK slash commands through channel policy and retains the native context until /new", async () => {
    const { agent, channel, run } = await piCommandChannel();
    const first = await run("/Review:1 Keep Case");
    expect(first.status).toBe(200);
    if (!("conversationId" in first.body))
      throw new Error("Missing SDK conversation");
    const conversationId = first.body.conversationId;
    const firstBinding = await nativeBinding(conversationId);
    expect(firstBinding.lastTask.executionBackend).toBe("pi-sdk");
    const revision = await db.agentRevision.findUniqueOrThrow({
      where: { id: assertDefined(firstBinding.context.agentRevisionId) },
    });
    expect(revision.agentId).toBe(agent.id);
    const messages = await db.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "/Review:1 Keep Case" }],
    });

    await db.agent.update({
      where: { id: agent.id },
      data: { systemPrompt: "Use the newly reviewed channel instructions." },
    });
    const nextRevision = await publishFixtureAgentRevision(
      workspace.id,
      agent.id,
    );
    expect(nextRevision.id).not.toBe(revision.id);
    await run("/AnotherCommand");
    const secondBinding = await nativeBinding(conversationId);
    expect(secondBinding.contextId).toBe(firstBinding.contextId);
    expect(secondBinding.context.agentRevisionId).toBe(revision.id);
    expect(secondBinding.lastTaskId).not.toBe(firstBinding.lastTaskId);
    await db.a2ATask.update({
      where: { id: secondBinding.lastTaskId },
      data: { state: TaskState.TASK_STATE_WORKING },
    });
    expect((await run("/Review:1")).body).toMatchObject({
      message: expect.stringContaining("busy"),
    });
    expect((await nativeBinding(conversationId)).lastTaskId).toBe(
      secondBinding.lastTaskId,
    );
    await db.a2ATask.update({
      where: { id: secondBinding.lastTaskId },
      data: { state: TaskState.TASK_STATE_COMPLETED },
    });

    const reset = await run("/new");
    if (!("conversationId" in reset.body))
      throw new Error("Missing reset SDK conversation");
    expect(reset.body.conversationId).not.toBe(conversationId);
    expect(
      await db.a2AEntryBinding.count({
        where: { sourceId: reset.body.conversationId },
      }),
    ).toBe(0);
    await run("/Review:1");
    expect((await nativeBinding(reset.body.conversationId)).contextId).not.toBe(
      firstBinding.contextId,
    );
    expect(
      (await nativeBinding(reset.body.conversationId)).context.agentRevisionId,
    ).toBe(nextRevision.id);

    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: null },
    });
    const taskCount = await db.a2ATask.count({
      where: { context: { agentId: agent.id } },
    });
    expect((await run("/Review:1")).status).toBe(409);
    expect(
      await db.a2ATask.count({ where: { context: { agentId: agent.id } } }),
    ).toBe(taskCount);
  });

  it("rejects a different authenticated actor and active native tasks before driving compaction", async () => {
    const { agent, channel, run } = await piCommandChannel();
    const first = await run("Keep this context private to its native owner.");
    if (!("conversationId" in first.body))
      throw new Error("Missing native conversation");
    const id = first.body.conversationId;
    const binding = await nativeBinding(id);
    const owner = assertDefined(identity.user);
    const stranger = await db.user.create({
      data: {
        email: `compact-stranger-${randomUUID()}@test.invalid`,
        passwordHash: "unused",
      },
    });
    await db.workspace.update({
      where: { id: workspace.id },
      data: { members: { create: { userId: stranger.id, role: "member" } } },
    });
    const request = (extra = {}) =>
      runtimeCommand(
        new Request("http://localhost/commands", {
          method: "POST",
          body: JSON.stringify({ line: "/compact", ...extra }),
        }),
        { params: Promise.resolve({ agentId: agent.id, conversationId: id }) },
      );
    const calls = vi.mocked(runNativeEntry).mock.calls.length;
    try {
      identity.user = stranger;
      expect((await request()).status).toBe(404);
      expect((await request({ actorId: owner.id })).status).toBe(400);
      identity.user = null;
      expect((await request()).status).toBe(401);
      await expect(
        executeRuntimeCommand({
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: id,
          line: "/compact",
        }),
      ).rejects.toMatchObject({ status: 404 });
      identity.user = owner;
      await db.agentChannelConnection.update({
        where: { id: channel.id },
        data: { a2aActorId: stranger.id },
      });
      expect((await request()).status).toBe(404);
      await db.agentChannelConnection.update({
        where: { id: channel.id },
        data: { a2aActorId: owner.id },
      });
      const conversation = await db.conversation.findUniqueOrThrow({
        where: { id },
      });
      const release = assertDefined(
        acquireConversationOperation(
          assertDefined(conversation.runtimeSessionKey),
        ),
      );
      try {
        expect((await request()).status).toBe(409);
      } finally {
        release();
      }
      for (const state of [
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
      ]) {
        await db.a2ATask.update({
          where: { id: binding.lastTaskId },
          data: { state },
        });
        expect((await request()).status).toBe(409);
        expect((await run("/compact")).body).toMatchObject({
          message: expect.stringContaining("busy"),
        });
      }
      expect(vi.mocked(runNativeEntry).mock.calls).toHaveLength(calls);
      expect(await db.message.count({ where: { conversationId: id } })).toBe(2);
      await db.a2ATask.update({
        where: { id: binding.lastTaskId },
        data: { state: TaskState.TASK_STATE_COMPLETED },
      });
      await expect(
        executeRuntimeCommand({
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationId: id,
          actorId: owner.id,
          line: "/compact",
          entry: { kind: "channel", channelId: channel.id },
        }),
      ).rejects.toMatchObject({ status: 400, message: "invalidCommand" });
      expect(vi.mocked(runNativeEntry).mock.calls).toHaveLength(calls);
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: "output",
        text: "Channel reply",
      });
      expect(vi.mocked(runNativeEntry).mock.calls).toHaveLength(calls + 1);
      const commandInput = assertDefined(
        vi.mocked(runNativeEntry).mock.calls.at(-1),
      )[0];
      expect(commandInput).toMatchObject({
        kind: "channel",
        channelId: channel.id,
        sourceId: id,
        actorId: owner.id,
        text: "/compact",
        messageId: expect.any(String),
      });
      const compacted = await nativeBinding(id);
      expect(compacted.contextId).toBe(binding.contextId);
      expect(compacted.context.agentRevisionId).toBe(
        binding.context.agentRevisionId,
      );
      expect(compacted.lastTaskId).not.toBe(binding.lastTaskId);
      expect(
        await db.a2AEntryReceipt.findUniqueOrThrow({
          where: {
            bindingId_messageId: {
              bindingId: binding.id,
              messageId: commandInput.messageId,
            },
          },
        }),
      ).toMatchObject({ taskId: compacted.lastTaskId });
    } finally {
      identity.user = owner;
      await db.agentChannelConnection.update({
        where: { id: channel.id },
        data: { a2aActorId: owner.id },
      });
      await db.a2ATask.update({
        where: { id: binding.lastTaskId },
        data: { state: TaskState.TASK_STATE_COMPLETED },
      });
      await db.user.delete({ where: { id: stranger.id } });
    }
  });

  it("requires explicit channel authority and stable message IDs, and deduplicates accepted native tasks", async () => {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        slug: "channel-authority",
        name: "Channel authority",
        runtimeKind: "pi-sdk",
        providerId,
        model: "test",
      },
    });
    await enableNativeAgent(agent.id);
    const channel = assertDefined(
      (
        await createAgentChannelConnection({
          workspaceId: workspace.id,
          agentId: agent.id,
          platform: "weixin",
          name: "Authority",
          credentials: {},
        })
      ).connection,
    );
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { status: "running" },
    });
    const messageId = randomUUID();
    const run = (
      message = "Authorized task",
      id: string | undefined = messageId,
    ) =>
      runAgentChannelMessage({
        workspaceId: workspace.id,
        connectionId: channel.id,
        agentId: agent.id,
        rawBody: {
          message,
          source: {
            chatId: "authority-chat",
            userId: "external-user-not-a-platform-account",
            messageId: id,
          },
        },
      });
    expect((await run()).status).toBe(409);
    expect(
      await db.a2ATask.count({ where: { context: { agentId: agent.id } } }),
    ).toBe(0);
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: assertDefined(identity.user).id },
    });
    expect(
      (
        await runAgentChannelMessage({
          workspaceId: workspace.id,
          connectionId: channel.id,
          agentId: agent.id,
          rawBody: {
            message: "No ID",
            source: {
              chatId: "authority-chat",
              userId: "external-user-not-a-platform-account",
            },
          },
        })
      ).status,
    ).toBe(400);
    const first = await run();
    expect(first.status).toBe(200);
    const replay = await run();
    expect(replay.body).toMatchObject({ message: "Channel reply" });
    expect(
      await db.a2ATask.count({ where: { context: { agentId: agent.id } } }),
    ).toBe(1);
    const binding = await nativeBinding(
      (first.body as { conversationId: string }).conversationId,
    );
    expect(binding.lastTask.grant).toMatchObject({
      actorId: assertDefined(identity.user).id,
    });
    await expect(run("Changed content")).rejects.toThrow(
      "reused with different content",
    );
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: null },
    });
    expect((await run("After revocation", randomUUID())).status).toBe(409);
    expect(
      await db.a2ATask.count({ where: { context: { agentId: agent.id } } }),
    ).toBe(1);
  });

  it("isolates sandbox configuration, migrates credentials, and routes pinned SDK turns to the target Agent session", async () => {
    const sandboxes = await Promise.all(
      ["Source", "Target"].map(async (name) => {
        const sandbox = await createSandbox(workspace.id, name);
        const agent = await db.agent.create({
          data: {
            workspaceId: workspace.id,
            name,
            slug: name.toLowerCase(),
            runtimeKind: "pi-sdk",
            providerId,
            model: "test",
          },
        });
        await db.agentSandbox.create({
          data: { agentId: agent.id, sandboxId: sandbox.id, isDefault: true },
        });
        await enableNativeAgent(agent.id, sandbox.id);
        return { ...sandbox, agent };
      }),
    );
    const [source, target] = sandboxes;
    const foreign = await createSandbox(other.id, "Foreign sandbox");
    const rawCreate = await command({
      action: "create",
      platform: "weixin",
      name: "WeChat sandbox",
      sandboxId: source.id,
      credentials: {
        WEIXIN_TOKEN: "wechat-private-token",
        WEIXIN_ACCOUNT_ID: "wechat-account",
      },
    });
    expect(rawCreate.status).toBe(200);
    const { connectionId } = await rawCreate.json();
    const before = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(before).toMatchObject({
      sandboxId: source.id,
      agentId: source.agent.id,
    });
    const listing = await GET(
      new Request(`http://localhost?sandboxId=${target.id}`),
      { params: Promise.resolve({ slug: workspace.slug }) },
    );
    expect((await listing.json()).connections).toEqual([]);
    expect(
      (
        await GET(new Request(`http://localhost?sandboxId=${foreign.id}`), {
          params: Promise.resolve({ slug: workspace.slug }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await command({
          action: "create",
          platform: "weixin",
          sandboxId: foreign.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await command({
          action: "update",
          connectionId,
          agentId: target.agent.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await command({ action: "move", connectionId, sandboxId: foreign.id }))
        .status,
    ).toBe(400);
    expect(
      (
        await command(
          { action: "move", connectionId, sandboxId: target.id },
          other.slug,
        )
      ).status,
    ).toBe(404);

    await db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { status: "running", a2aActorId: assertDefined(identity.user).id },
    });
    const run = (agent: string, sandbox: string, conversationId?: string) =>
      runAgentChannelMessage({
        workspaceId: workspace.id,
        connectionId,
        agentId: agent,
        sandboxId: sandbox,
        rawBody: {
          message: "Hello",
          conversationId,
          source: {
            chatId: "wechat-user",
            userId: "wechat-user",
            messageId: randomUUID(),
          },
        },
      });
    const original = await run(source.agent.id, source.id);
    expect(original.status).toBe(200);
    const historyId = (original.body as { conversationId: string })
      .conversationId;
    vi.mocked(liveAgentChannelStatus).mockReturnValue("running");
    vi.mocked(startAgentChannelRunner).mockResolvedValue({});
    vi.mocked(stopAgentChannelRunner).mockClear();
    vi.mocked(startAgentChannelRunner).mockClear();
    const moved = await command({
      action: "move",
      connectionId,
      sandboxId: target.id,
    });
    expect(moved.status).toBe(200);
    expect(JSON.stringify(await moved.json())).not.toContain(
      "wechat-private-token",
    );
    const after = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(after).toMatchObject({
      sandboxId: target.id,
      agentId: target.agent.id,
      credentials: before.credentials,
      config: before.config,
      inboundTokenHash: before.inboundTokenHash,
    });
    expect(
      vi.mocked(stopAgentChannelRunner).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(startAgentChannelRunner).mock.invocationCallOrder[0],
    );
    await db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { status: "running", a2aActorId: assertDefined(identity.user).id },
    });
    expect((await run(source.agent.id, source.id)).status).toBe(404);
    expect((await run(target.agent.id, target.id, historyId)).status).toBe(404);
    const targetReply = await run(target.agent.id, target.id);
    expect(targetReply.status).toBe(200);
    const targetBinding = await nativeBinding(
      (targetReply.body as { conversationId: string }).conversationId,
    );
    expect(targetBinding.context).toMatchObject({
      targetKind: "local",
      agentId: target.agent.id,
    });
    expect(targetBinding.lastTask.grant).toMatchObject({
      actorId: assertDefined(identity.user).id,
    });
    expect((await nativeBinding(historyId)).context.agentId).toBe(
      source.agent.id,
    );
    expect(runNativeEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "channel",
        channelId: connectionId,
        actorId: assertDefined(identity.user).id,
        agentId: target.agent.id,
      }),
    );
    expect(
      await db.conversation.findUnique({ where: { id: historyId } }),
    ).toMatchObject({ agentId: source.agent.id });

    vi.mocked(startAgentChannelRunner)
      .mockResolvedValueOnce({ error: "Cannot connect" })
      .mockResolvedValue({});
    expect(
      (await command({ action: "move", connectionId, sandboxId: source.id }))
        .status,
    ).toBe(400);
    expect(
      await db.agentChannelConnection.findUnique({
        where: { id: connectionId },
      }),
    ).toMatchObject({
      sandboxId: target.id,
      agentId: target.agent.id,
      credentials: before.credentials,
    });

    const empty = await createSandbox(workspace.id, "Unassigned");
    expect(
      (await command({ action: "move", connectionId, sandboxId: empty.id }))
        .status,
    ).toBe(200);
    expect(
      await db.agentChannelConnection.findUnique({
        where: { id: connectionId },
      }),
    ).toMatchObject({
      sandboxId: empty.id,
      agentId: null,
      status: "stopped",
      credentials: before.credentials,
    });
    await command({ action: "delete", connectionId });
  });

  it("requires an account and refuses simple cross-origin form requests", async () => {
    const user = identity.user;
    identity.user = null;
    try {
      expect(
        (
          await GET(new Request("http://localhost"), {
            params: Promise.resolve({ slug: workspace.slug }),
          })
        ).status,
      ).toBe(401);
    } finally {
      identity.user = user;
    }
    expect(
      (
        await POST(
          new Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "{}",
          }),
          {
            params: Promise.resolve({ slug: workspace.slug }),
          },
        )
      ).status,
    ).toBe(415);
  });

  it("creates a draft, binds and edits it without returning secrets, and keeps workspace boundaries", async () => {
    const created = await command({
      action: "create",
      platform: "discord",
      name: "Support",
    });
    expect(created.status).toBe(200);
    const data = await created.json();
    const connectionId = data.connectionId;
    expect(
      data.connections.find(
        (connection: { id: string }) => connection.id === connectionId,
      ),
    ).toMatchObject({ agentId: null, status: "setup_required" });
    expect(JSON.stringify(data)).not.toMatch(
      /inboundToken|credentials"|workspaceId|runnerPid/,
    );

    const updated = await command({
      action: "update",
      connectionId,
      agentId,
      name: "Renamed",
      credentials: {
        DISCORD_BOT_TOKEN: "private-bot-secret",
        DISCORD_ALLOWED_USERS: "42",
      },
    });
    expect(updated.status).toBe(200);
    const view = await updated.json();
    expect(JSON.stringify(view)).not.toContain("private-bot-secret");
    expect(
      view.connections.find(
        (connection: { id: string }) => connection.id === connectionId,
      ),
    ).toMatchObject({
      name: "Renamed",
      agentId,
      credentialValues: { DISCORD_ALLOWED_USERS: "42" },
    });
    expect(
      (
        await command({
          action: "update",
          connectionId,
          credentials: { DISCORD_BOT_TOKEN: "", DISCORD_ALLOWED_USERS: "" },
        })
      ).status,
    ).toBe(200);
    const raw = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(decryptChannelCredentials(raw.credentials)).toEqual({
      DISCORD_BOT_TOKEN: "private-bot-secret",
    });
    expect(JSON.stringify(raw.credentials)).not.toContain("private-bot-secret");

    expect(
      (
        await command({
          action: "update",
          connectionId,
          agentId: foreignAgentId,
        })
      ).status,
    ).toBe(400);
    for (const action of [
      "update",
      "start",
      "stop",
      "delete",
      "pair",
      "check",
      "apply",
    ]) {
      expect((await command({ action, connectionId }, other.slug)).status).toBe(
        404,
      );
    }
    const logs = await GET(
      new Request(`http://localhost?logs=${connectionId}`),
      { params: Promise.resolve({ slug: other.slug }) },
    );
    expect(logs.status).toBe(404);
    expect(
      (
        await command({
          action: "update",
          connectionId,
          credentials: { NODE_OPTIONS: "--require=bad" },
        })
      ).status,
    ).toBe(400);
    expect((await command({ action: "start", connectionId })).status).toBe(400);
    expect((await command({ action: "delete", connectionId })).status).toBe(
      200,
    );
    expect(
      await db.agentChannelConnection.findUnique({
        where: { id: connectionId },
      }),
    ).toBeNull();
  });

  it("polls Feishu registration and stores its device code and app secret encrypted", async () => {
    const created = await (
      await command({
        action: "create",
        platform: "feishu",
        name: "Feishu QR",
        credentials: { FEISHU_DOMAIN: "lark" },
      })
    ).json();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ supported: true }))
      .mockResolvedValueOnce(
        Response.json({
          device_code: "private-device-code",
          verification_uri_complete: "https://accounts.larksuite.com/qr/test",
          interval: 5,
          expires_in: 600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          client_id: "cli_test",
          client_secret: "private-app-secret",
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const paired = await command({
      action: "pair",
      connectionId: created.connectionId,
    });
    expect(paired.status).toBe(200);
    expect(JSON.stringify(await paired.json())).not.toContain(
      "private-device-code",
    );
    expect(fetch.mock.calls[0][0]).toBe(
      "https://accounts.larksuite.com/oauth/v1/app/registration",
    );
    expect(fetch.mock.calls[1][1].body).toContain("action=begin");
    const checked = await command({
      action: "check",
      connectionId: created.connectionId,
    });
    expect(checked.status).toBe(200);
    const data = await checked.json();
    const channel = data.connections.find(
      (item: { id: string }) => item.id === created.connectionId,
    );
    expect(channel).toMatchObject({
      pairing: { status: "ready" },
      missingStartCredentialNames: [],
      credentialValues: { FEISHU_APP_ID: "cli_test", FEISHU_DOMAIN: "lark" },
    });
    expect(JSON.stringify(data)).not.toContain("private-app-secret");
    const raw = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: created.connectionId },
    });
    expect(decryptChannelCredentials(raw.credentials).FEISHU_APP_SECRET).toBe(
      "private-app-secret",
    );
  });

  it("isolates two bots in the same chat, handles commands, and rejects stopped or unauthorized ingress", async () => {
    await enableNativeAgent(agentId);
    const channels = await Promise.all(
      ["Bot 1", "Bot 2"].map((name) =>
        createAgentChannelConnection({
          workspaceId: workspace.id,
          agentId,
          platform: "telegram",
          name,
          credentials: {
            TELEGRAM_BOT_TOKEN: "test-token",
            TELEGRAM_ALLOWED_USERS: "42",
          },
        }),
      ),
    );
    const [first, second] = channels.map((channel) =>
      assertDefined(channel.connection),
    );
    await db.agentChannelConnection.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { status: "running", a2aActorId: assertDefined(identity.user).id },
    });
    const run = (connectionId: string, message: string, extras = {}) =>
      runAgentChannelMessage({
        connectionId,
        workspaceId: workspace.id,
        agentId,
        rawBody: {
          message,
          source: {
            userId: "42",
            chatId: "same-chat",
            platform: "spoofed",
            chatType: "dm",
            messageId: randomUUID(),
          },
          ...extras,
        },
      });
    const a = await run(first.id, "Hello");
    const b = await run(second.id, "Hello");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    if (
      a.status !== 200 ||
      b.status !== 200 ||
      !("conversationId" in a.body) ||
      !("conversationId" in b.body)
    )
      throw new Error("Missing reply");
    expect(a.body.conversationId).not.toBe(b.body.conversationId);
    expect(a.body.platform).toBe("telegram");
    expect(
      (
        await run(first.id, "Cross-channel", {
          conversationId: b.body.conversationId,
        })
      ).status,
    ).toBe(404);
    const whoami = await run(first.id, "/whoami");
    expect(whoami.body).toMatchObject({
      conversationId: a.body.conversationId,
      message: expect.stringContaining("User ID: 42"),
    });
    const reset = await run(first.id, "/new");
    expect(reset.body).toMatchObject({
      conversationId: expect.not.stringMatching(a.body.conversationId),
    });
    const next = await run(first.id, "Fresh");
    expect(next.body).toMatchObject({
      conversationId: (reset.body as { conversationId: string }).conversationId,
    });
    expect(
      (
        await run(first.id, "Denied", {
          source: { chatId: "same-chat", userId: "43" },
        })
      ).status,
    ).toBe(403);
    await db.agentChannelConnection.update({
      where: { id: first.id },
      data: { status: "stopped" },
    });
    expect((await run(first.id, "Stopped")).status).toBe(409);
    await db.agentChannelConnection.update({
      where: { id: first.id },
      data: { agentId: null },
    });
    expect(
      (
        await runAgentChannelMessage({
          connectionId: first.id,
          workspaceId: workspace.id,
          agentId: null,
          rawBody: { message: "Unbound" },
        })
      ).status,
    ).toBe(409);
  });
});
