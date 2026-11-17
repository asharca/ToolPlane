import "server-only";
import type {
  AgentChannelInboundEvent,
  AgentChannelConnection,
  Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { parseAgentMessageBody } from "./chat-body";
import {
  buildMessagingSessionKey,
  normalizeAgentMessageEvent,
} from "./messaging";
import { admitChannelSender } from "./channel-sender-access";
import { decryptChannelCredentials } from "./channel-connections";
import {
  runningChannelMessageQueue,
  AgentMessageQueueError,
} from "./execution/message-queue";

function normalized(
  row: AgentChannelInboundEvent,
  connection: AgentChannelConnection,
) {
  const saved = row.payload as Record<string, unknown>;
  if (
    saved.agentId !== connection.agentId ||
    saved.sandboxId !== connection.sandboxId
  )
    return null;
  if (row.kind === "callback") return parseAgentMessageBody(saved.body);
  const event = saved.event as
    | {
        text: string;
        chatId: string;
        userId?: string;
        userName?: string;
        messageId?: string;
        chatType?: string;
        threadId?: string;
        conversationId?: string;
        roleIds?: string[];
        images?: unknown[];
        files?: unknown[];
      }
    | undefined;
  if (!event || event.images?.length || event.files?.length) return null;
  return parseAgentMessageBody({
    message: event.text,
    conversationId: event.conversationId,
    source: {
      platform: connection.platform,
      chatId: event.chatId,
      userId: event.userId,
      userName: event.userName,
      messageId: event.messageId,
      chatType: event.chatType,
      threadId: event.threadId,
    },
    metadata: { roleIds: event.roleIds },
  });
}

/** Called only for a durable row, after deduplication, without claiming another turn. */
export async function queueRunningChannelMessages(
  connectionId: string,
  queueKey: string,
) {
  const connection = await db.agentChannelConnection.findUnique({
    where: { id: connectionId },
  });
  if (
    !connection?.agentId ||
    !connection.a2aActorId ||
    !["running", "starting", "waiting_callback"].includes(connection.status)
  )
    return;
  const rows = await db.agentChannelInboundEvent.findMany({
    where: { connectionId, queueKey, status: "queued" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    const body = normalized(row, connection);
    // Commands and unsupported attachments retain their existing ingress behavior.
    if (!body || body.attachments.length || body.message.trim().startsWith("/"))
      return;
    const event = normalizeAgentMessageEvent(body);
    const decision = await admitChannelSender({
      connection,
      credentials: decryptChannelCredentials(connection.credentials),
      source: event.source,
      roleIds: body.metadata?.roleIds,
    });
    if (!decision.allowed) return;
    const scope = {
      workspaceId: connection.workspaceId,
      agentId: connection.agentId,
      actorId: connection.a2aActorId,
      channelId: connection.id,
      conversationId: body.conversationId,
    };
    let control = runningChannelMessageQueue({
      ...scope,
      sessionKey: queueKey,
    });
    if (!control) {
      const saved = row.payload as {
        hostedIngress?: boolean;
        legacySessionKey?: string;
      };
      const source =
        row.kind === "hosted" || saved.hostedIngress
          ? {
              ...event.source,
              chatType: "dm" as const,
              threadId:
                event.source.platform === "feishu" && event.source.threadId
                  ? `thread:${event.source.threadId}`
                  : undefined,
            }
          : event.source;
      control = runningChannelMessageQueue({
        ...scope,
        sessionKey: `channel:${connection.id}:${saved.legacySessionKey ?? buildMessagingSessionKey(source)}`,
      });
    }
    if (!control) return;
    try {
      const result = await control.send({
        id: row.id,
        mode: "steer",
        text: event.promptText,
        deduplicate: true,
      });
      // An input extension may handle the message without placing it in Pi's queue.
      if (result.disposition === "handled")
        await settleQueuedChannelMessage(
          db,
          row.id,
          connection.id,
          control.conversationId,
        );
    } catch (error) {
      if (
        error instanceof AgentMessageQueueError &&
        [
          "AGENT_QUEUE_NOT_RUNNING",
          "AGENT_QUEUE_INVALID",
          "AGENT_QUEUE_FULL",
        ].includes(error.code)
      )
        return;
      throw error;
    }
  }
}

/** Consumption and the transcript commit share a transaction; queued rows survive host loss/clear. */
export async function settleQueuedChannelMessage(
  tx: Pick<
    Prisma.TransactionClient,
    "agentChannelInboundEvent" | "agentChannelConnection"
  >,
  id: string,
  connectionId: string,
  conversationId: string,
) {
  const row = await tx.agentChannelInboundEvent.findFirst({
    where: { id, connectionId },
  });
  const connection = await tx.agentChannelConnection.findUnique({
    where: { id: connectionId },
  });
  if (!row || !connection) return;
  const body = normalized(row, connection);
  if (!body) return;
  const event = normalizeAgentMessageEvent(body);
  const result = {
    status: 200,
    body: {
      agentId: connection.agentId,
      conversationId,
      delivery: "silent",
      message: "",
      rawMessage: "",
      sessionKey: row.queueKey,
      source: event.source,
      platform: connection.platform,
      externalUserId: event.source.userId ?? null,
      channelId: event.source.chatId ?? null,
    },
  };
  await tx.agentChannelInboundEvent.updateMany({
    where: { id, connectionId },
    data: {
      status: "done",
      leaseUntil: null,
      lastError: null,
      payload: JSON.parse(
        JSON.stringify({ ...(row.payload as object), result }),
      ) as Prisma.InputJsonValue,
    },
  });
}
