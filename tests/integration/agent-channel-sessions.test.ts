// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecretText } from "@/lib/security/secrets";
import {
  runAgentChannelMessage,
  type AgentMessageResult,
} from "@/lib/agents/message-service";
import { submitAgentEntry } from "@/lib/agents/execution/entries";
import { claimTask, finishTask } from "@/lib/a2a/store";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { createConversation } from "@/lib/agents/mutations";
import { buildMessagingSessionKey } from "@/lib/agents/messaging";
import {
  persistChannelInboundEvent,
  recoverChannelInboundEvents,
  registerChannelInboundHandler,
  processChannelInboundQueue,
} from "@/lib/agents/channel-inbound-queue";
import { POST as channelCallback } from "@/app/api/v1/agent-channels/[connectionId]/events/route";
import { hashAgentChannelToken } from "@/lib/agents/channel-token";

let workspaceId: string;
let foreignWorkspaceId: string;
let userId: string;
let agentId: string;
let providerId: string;
let foreignProviderId: string;
let connectionId: string;

beforeAll(async () => {
  const suffix = randomUUID();
  const user = await db.user.create({
    data: {
      email: `channel-sessions-${suffix}@test.dev`,
      passwordHash: "unused",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `channel-sessions-${suffix}`,
      name: "Channel sessions",
      ownerId: userId,
    },
  });
  workspaceId = workspace.id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `channel-sessions-other-${suffix}`,
        name: "Other",
        ownerId: userId,
      },
    })
  ).id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Models",
      format: "openai",
      baseUrl: "https://example.invalid",
      apiKey: "unused",
      models: ["default", "alternate"],
    },
  });
  providerId = provider.id;
  foreignProviderId = (
    await db.modelProvider.create({
      data: {
        workspaceId: foreignWorkspaceId,
        name: "Foreign",
        format: "openai",
        baseUrl: "https://example.invalid",
        apiKey: "unused",
        models: ["foreign"],
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "channel-sessions",
        name: "Channel sessions",
        runtimeKind: "pi-sdk",
        providerId,
        model: "default",
      },
    })
  ).id;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: "Channel session sandbox", status: "stopped" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: "Channel session sandbox",
      slug: "channel-session-sandbox",
      kind: "docker",
      network: "isolated",
    },
  });
  await db.agentSandbox.create({
    data: { agentId, sandboxId: sandbox.id, isDefault: true },
  });
  await publishFixtureAgentRevision(workspaceId, agentId);
});

beforeEach(async () => {
  const id = randomUUID();
  connectionId = (
    await db.agentChannelConnection.create({
      data: {
        workspaceId,
        agentId,
        platform: "telegram",
        name: "Sessions",
        status: "waiting_callback",
        senderPolicyVersion: 2,
        openToAll: true,
        adminUserIds: ["admin"],
        a2aActorId: userId,
        credentials: {},
        inboundTokenHash: id,
        inboundTokenPrefix: id.slice(0, 12),
        inboundTokenSecret: encryptSecretText(id),
        groupSessionsPerUser: true,
      },
    })
  ).id;
});

afterAll(async () => {
  await db.logEvent.deleteMany({
    where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.user.delete({ where: { id: userId } });
});

async function command(
  message: string,
  sender = "admin",
  chatType: "dm" | "group" = "dm",
  hostedIngress = false,
) {
  const result = await runAgentChannelMessage({
    workspaceId,
    agentId,
    connectionId,
    hostedIngress,
    rawBody: {
      message,
      source: {
        platform: "telegram",
        chatId: "chat",
        chatType,
        userId: sender,
        messageId: randomUUID(),
      },
    },
  });
  if ("error" in result.body) throw new Error(result.body.error);
  return result.body;
}

async function conversation(id: string) {
  return db.conversation.findFirstOrThrow({
    where: { id, agentId, agent: { workspaceId } },
  });
}

describe("durable channel sessions", () => {
  it("restricts model changes to admins and validates workspace provider ownership", async () => {
    const initial = await command("/new now");
    const denied = await command(`/model ${providerId}:alternate`, "user");
    expect(denied.message).toContain("User ID: user");
    expect(denied.message).toContain("channel admin");
    expect(
      (await conversation(initial.conversationId)).modelOverride,
    ).toBeNull();
    expect(
      (await command(`/model ${foreignProviderId}:foreign`)).message,
    ).toContain("Model unavailable");
    expect(
      (await conversation(initial.conversationId)).modelOverride,
    ).toBeNull();
  });

  it("stores a session-only override and the real entry grant resolves it for the next turn", async () => {
    const initial = await command(`/model ${providerId}:alternate`);
    expect(
      (await conversation(initial.conversationId)).modelOverride,
    ).toMatchObject({ providerId, model: "alternate", setBy: "admin" });
    const accepted = await submitAgentEntry(
      {
        kind: "channel",
        sourceId: initial.conversationId,
        channelId: connectionId,
        workspaceId,
        agentId,
        actorId: userId,
        messageId: randomUUID(),
        text: "Use the session model",
      },
      () => {},
    );
    expect(accepted.row.grant).toMatchObject({
      modelOverride: { providerId, model: "alternate" },
    });
    const running = await claimTask(accepted.row.id);
    if (!running?.leaseToken) throw new Error("Task was not claimed");
    await finishTask(
      running.id,
      running.leaseToken,
      TaskState.TASK_STATE_CANCELED,
    );
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.model).toBe("default");
    const revision = await db.agentRevision.findUniqueOrThrow({
      where: {
        agentId_version: { agentId, version: agent.currentRevisionVersion },
      },
    });
    expect((await conversation(initial.conversationId)).agentRevisionId).toBe(
      revision.id,
    );
    await command("/model reset");
    expect(
      (await conversation(initial.conversationId)).modelOverride,
    ).toBeNull();
  });

  it("fails real turn admission when a stored override model is removed", async () => {
    const selected = await command(`/model ${providerId}:alternate`);
    await db.modelProvider.update({
      where: { id: providerId },
      data: { models: ["default"] },
    });
    try {
      await expect(
        submitAgentEntry(
          {
            kind: "channel",
            sourceId: selected.conversationId,
            channelId: connectionId,
            workspaceId,
            agentId,
            actorId: userId,
            messageId: randomUUID(),
            text: "Must not silently use another model",
          },
          () => {},
        ),
      ).rejects.toThrow("MODEL_OVERRIDE_UNAVAILABLE");
    } finally {
      await db.modelProvider.update({
        where: { id: providerId },
        data: { models: ["default", "alternate"] },
      });
    }
  });

  it("binds confirmations to the requesting sender and leaves history unchanged until confirmed", async () => {
    const pending = await command("/new");
    expect(pending.confirmation?.command).toBe("new");
    expect(pending.conversationId).toBe("");
    if (!pending.confirmation) throw new Error("Confirmation was not issued");
    const wrongSender = await command(
      `/new --confirm ${pending.confirmation.token}`,
      "other",
    );
    expect(wrongSender.conversationId).toBe("");
    const confirmed = await command(
      `/new --confirm ${pending.confirmation.token}`,
    );
    expect(confirmed.message).toBe("New conversation started.");
    expect(confirmed.conversationId).not.toBe("");
  });

  it("resumes the selected conversation without rekeying, and new conversations have no override", async () => {
    const old = await command(`/model ${providerId}:alternate`);
    const fresh = await command("/new now");
    expect(fresh.conversationId).not.toBe(old.conversationId);
    expect((await conversation(fresh.conversationId)).modelOverride).toBeNull();
    const resumed = await command("/resume 1");
    expect(resumed.conversationId).toBe(old.conversationId);
    expect((await command("/status")).conversationId).toBe(old.conversationId);
    expect(
      (await conversation(old.conversationId)).channelSelectedAt,
    ).not.toBeNull();
  });

  it("upgrades only for channel admins and preserves the session override", async () => {
    const initial = await command(`/model ${providerId}:alternate`);
    const old = await conversation(initial.conversationId);
    await db.agent.update({
      where: { id: agentId },
      data: { systemPrompt: `Revision ${randomUUID()}` },
    });
    await publishFixtureAgentRevision(workspaceId, agentId);
    expect((await command("/upgrade now", "user")).message).toContain(
      "channel admin",
    );
    expect((await conversation(initial.conversationId)).agentRevisionId).toBe(
      old.agentRevisionId,
    );
    expect((await command("/upgrade now")).message).toContain(
      "Conversation upgraded",
    );
    const upgraded = await conversation(initial.conversationId);
    expect(upgraded.agentRevisionId).not.toBe(old.agentRevisionId);
    expect(upgraded.modelOverride).toEqual(old.modelOverride);
  });

  it("uses a stable hash when ingress has no platform message ID", async () => {
    const rawBody = {
      message: "/new now",
      source: {
        platform: "telegram",
        chatId: "hash-chat",
        chatType: "dm",
        userId: "admin",
      },
    };
    const first = await runAgentChannelMessage({
      workspaceId,
      agentId,
      connectionId,
      rawBody,
    });
    const duplicate = await runAgentChannelMessage({
      workspaceId,
      agentId,
      connectionId,
      rawBody,
    });
    expect(duplicate.body).toEqual(first.body);
    expect(
      await db.agentChannelInboundEvent.count({ where: { connectionId } }),
    ).toBe(1);
    expect(
      await db.conversation.count({
        where: {
          agentId,
          runtimeSessionKey: `channel:${connectionId}:msg:telegram:dm:hash-chat`,
        },
      }),
    ).toBe(1);
  });

  it("does not conflate Telegram message IDs from different chats", async () => {
    for (const chatId of ["telegram-a", "telegram-b"]) {
      const result = await runAgentChannelMessage({
        workspaceId,
        agentId,
        connectionId,
        rawBody: {
          message: "/new now",
          source: {
            platform: "telegram",
            chatId,
            chatType: "dm",
            userId: "admin",
            messageId: "1",
          },
        },
      });
      expect(result.status).toBe(200);
    }
    expect(
      await db.agentChannelInboundEvent.count({ where: { connectionId } }),
    ).toBe(2);
    expect(
      await db.conversation.count({
        where: {
          agentId,
          runtimeSessionKey: { startsWith: `channel:${connectionId}:` },
        },
      }),
    ).toBe(2);
  });

  it("recovers an expired processing lease once and ignores platform redelivery", async () => {
    const body = {
      message: "/new now",
      source: {
        platform: "telegram",
        chatId: "chat",
        chatType: "dm",
        userId: "admin",
        messageId: "recover-message",
      },
    };
    const queueKey = `channel:${connectionId}:msg:telegram:dm:chat`;
    const saved = await persistChannelInboundEvent({
      connectionId,
      workspaceId,
      queueKey,
      dedupeKey: "recover-message",
      kind: "callback",
      payload: { body, workspaceId, agentId, sandboxId: null },
    });
    await db.agentChannelInboundEvent.update({
      where: { id: saved.event.id },
      data: {
        status: "processing",
        attempts: 1,
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await recoverChannelInboundEvents(connectionId);
    const completed = await db.agentChannelInboundEvent.findUniqueOrThrow({
      where: { id: saved.event.id },
    });
    expect(completed.status).toBe("done");
    expect(completed.attempts).toBe(2);
    expect(
      await db.conversation.count({
        where: { agentId, runtimeSessionKey: queueKey },
      }),
    ).toBe(1);
    const duplicate = await persistChannelInboundEvent({
      connectionId,
      workspaceId,
      queueKey,
      dedupeKey: "recover-message",
      kind: "callback",
      payload: { body, workspaceId, agentId, sandboxId: null },
    });
    expect(duplicate.duplicate).toBe(true);
    await recoverChannelInboundEvents(connectionId);
    expect(
      await db.conversation.count({
        where: { agentId, runtimeSessionKey: queueKey },
      }),
    ).toBe(1);
    expect(
      (
        await db.agentChannelInboundEvent.findUniqueOrThrow({
          where: { id: saved.event.id },
        })
      ).attempts,
    ).toBe(2);
  });

  it("retries hosted command delivery without repeating new or shifting resume selection", async () => {
    const old = await command("/new now");
    const queueKey = `channel:${connectionId}:msg:telegram:dm:chat`;
    const replies: AgentMessageResult[] = [];
    const failedDeliveries = new Set<string>();
    const unregister = registerChannelInboundHandler(
      connectionId,
      async (payload, dedupeKey) => {
        const saved = z
          .object({
            event: z.object({
              text: z.string(),
              chatId: z.string(),
              userId: z.string(),
              messageId: z.string(),
            }),
          })
          .parse(payload);
        const result = await runAgentChannelMessage({
          workspaceId,
          agentId,
          connectionId,
          inboundPersisted: true,
          inboundDedupeKey: dedupeKey,
          hostedIngress: true,
          rawBody: {
            message: saved.event.text,
            source: {
              platform: "telegram",
              chatType: "dm",
              chatId: saved.event.chatId,
              userId: saved.event.userId,
              messageId: saved.event.messageId,
            },
          },
        });
        const receipt = await db.agentChannelInboundEvent.findUniqueOrThrow({
          where: { connectionId_dedupeKey: { connectionId, dedupeKey } },
        });
        expect(receipt.payload).toHaveProperty(
          "result",
          JSON.parse(JSON.stringify(result)),
        );
        if (!failedDeliveries.has(dedupeKey)) {
          failedDeliveries.add(dedupeKey);
          throw new Error("Platform sendMessage failed after command commit");
        }
        replies.push(result);
      },
    );
    try {
      for (const text of ["/new now", "/resume 1"]) {
        const messageId = randomUUID();
        const saved = await persistChannelInboundEvent({
          workspaceId,
          connectionId,
          queueKey,
          dedupeKey: `chat:${messageId}`,
          kind: "hosted",
          payload: {
            event: { text, chatId: "chat", userId: "admin", messageId },
            agentId,
            sandboxId: null,
          },
        });
        await processChannelInboundQueue(connectionId, queueKey);
        const completed = await db.agentChannelInboundEvent.findUniqueOrThrow({
          where: { id: saved.event.id },
        });
        expect(completed).toMatchObject({ status: "done", attempts: 2 });
        expect(
          await db.conversation.count({
            where: { agentId, runtimeSessionKey: queueKey },
          }),
        ).toBe(2);
      }
      expect(replies).toHaveLength(2);
      expect(replies[0].body).toMatchObject({
        message: "New conversation started.",
      });
      expect(replies[0].body).not.toMatchObject({
        conversationId: old.conversationId,
      });
      expect(replies[1].body).toMatchObject({
        conversationId: old.conversationId,
        message: `Resumed conversation ${old.conversationId.slice(0, 10)}.`,
      });
      expect((await command("/status")).conversationId).toBe(
        old.conversationId,
      );
    } finally {
      unregister();
    }
  });

  it("continues exact pre-redesign callback keys for Telegram topics, Discord DMs and Slack roots/replies", async () => {
    const cases = [
      {
        platform: "telegram",
        key: "msg:telegram:group:topic-chat:42",
        body: {
          message: {
            text: "/status",
            message_id: 1,
            message_thread_id: 42,
            chat: { id: "topic-chat", type: "supergroup" },
            from: { id: "admin" },
          },
        },
      },
      {
        platform: "discord",
        key: "msg:discord:channel:dm-chat:admin",
        body: {
          content: "/status",
          id: "discord-message",
          channel_id: "dm-chat",
          author: { id: "admin" },
        },
      },
      {
        platform: "slack",
        key: "msg:slack:channel:root-chat:100.001",
        body: {
          event: {
            text: "/status",
            ts: "100.001",
            channel: "root-chat",
            channel_type: "channel",
            user: "admin",
          },
        },
      },
      {
        platform: "slack",
        key: "msg:slack:channel:reply-chat:100.001",
        body: {
          event: {
            text: "/status",
            ts: "100.002",
            thread_ts: "100.001",
            channel: "reply-chat",
            channel_type: "channel",
            user: "admin",
          },
        },
      },
    ];
    const token = randomUUID();
    for (const fixture of cases) {
      await db.agentChannelConnection.update({
        where: { id: connectionId },
        data: {
          platform: fixture.platform,
          inboundTokenHash: hashAgentChannelToken(token),
        },
      });
      const key = `channel:${connectionId}:${fixture.key}`;
      const legacy = await createConversation(
        workspaceId,
        agentId,
        "Existing callback conversation",
        { runtimeSessionKey: key },
      );
      if (!legacy) throw new Error("Legacy callback fixture not created");
      const response = await channelCallback(
        new Request("http://localhost/events", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(fixture.body),
        }),
        { params: Promise.resolve({ connectionId }) },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        conversationId: legacy.id,
        sessionKey: key,
      });
      expect((await conversation(legacy.id)).runtimeSessionKey).toBe(key);
      expect(
        await db.conversation.count({
          where: {
            agentId,
            runtimeSessionKey: { startsWith: `channel:${connectionId}:` },
          },
        }),
      ).toBe(cases.indexOf(fixture) + 1);
    }
  });

  it("honors group per-user routing and continues a hosted legacy dm key without rekeying", async () => {
    const first = await command("/new now", "one", "group");
    const second = await command("/new now", "two", "group");
    expect(first.conversationId).not.toBe(second.conversationId);
    await db.agentChannelConnection.update({
      where: { id: connectionId },
      data: { groupSessionsPerUser: false },
    });
    const shared = await command("/new now", "one", "group");
    expect((await command("/status", "two", "group")).conversationId).toBe(
      shared.conversationId,
    );
    await db.conversation.deleteMany({
      where: {
        agentId,
        runtimeSessionKey: { startsWith: `channel:${connectionId}:` },
      },
    });
    const legacyKey = `channel:${connectionId}:${buildMessagingSessionKey({ platform: "telegram", chatId: "chat", chatType: "dm", userId: "one" })}`;
    const legacy = await createConversation(
      workspaceId,
      agentId,
      "Old hosted conversation",
      { runtimeSessionKey: legacyKey },
    );
    if (!legacy) throw new Error("Legacy fixture not created");
    expect(
      (await command("/status", "one", "group", true)).conversationId,
    ).toBe(legacy.id);
    expect((await conversation(legacy.id)).runtimeSessionKey).toBe(legacyKey);
  });
});
