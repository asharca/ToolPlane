import "server-only";
import { randomInt } from "node:crypto";
import type { AgentChannelConnection, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withLogContext } from "@/lib/observability/context";
import { recordEvent } from "@/lib/observability/events";
import { writeAudit } from "@/lib/observability/audit";
import {
  decryptSecretRecord,
  encryptSecretRecord,
} from "@/lib/security/secrets";
import { hostedRunnerSpec } from "@/lib/agents/platform-runner";
import { sendChannelNotice } from "@/lib/agents/channel-runtime";

export type ChannelChatType = "dm" | "group" | "channel" | "thread";
export type ChannelSenderSource = {
  userId?: string;
  userName?: string;
  chatId?: string;
  chatType?: ChannelChatType;
  threadId?: string;
};
export type ChannelAccessConnection = Pick<
  AgentChannelConnection,
  | "id"
  | "workspaceId"
  | "agentId"
  | "platform"
  | "senderPolicyVersion"
  | "openToAll"
  | "unauthorizedDm"
  | "adminUserIds"
>;
export type ChannelSenderDecision =
  | { allowed: true; role: "admin" | "user" }
  | {
      allowed: false;
      rule:
        | "disabled"
        | "chat_not_allowed"
        | "role_not_allowed"
        | "user_not_allowed";
      reply?: string;
    };

type DenialRule = Extract<ChannelSenderDecision, { allowed: false }>["rule"];
const rejectedAt = new Map<string, number>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function pairingCode() {
  return Array.from(
    { length: 8 },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
}
function ids(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
function includesId(list: string[], id: string | undefined) {
  return list.includes("*") || Boolean(id && list.includes(id));
}
function legacyRule(
  platform: string,
  credentials: Record<string, string>,
  source: ChannelSenderSource,
  roleIds: unknown,
): DenialRule | null {
  const prefix = platform.toUpperCase();
  const users = credentials[`${prefix}_ALLOWED_USERS`];
  const policy =
    credentials[
      `${prefix}_${source.chatType && source.chatType !== "dm" ? "GROUP" : "DM"}_POLICY`
    ];
  if (policy === "disabled") return "disabled";
  if (
    (["allowlist", "pairing"].includes(policy) && !users?.trim()) ||
    (!users?.trim() && credentials[`${prefix}_ALLOW_ALL_USERS`] === "false")
  )
    return "user_not_allowed";
  const allows = (raw: string | undefined, id: string | undefined) => {
    const values = ids(raw);
    return !values.length || includesId(values, id);
  };
  if (
    platform === "discord" &&
    credentials.DISCORD_ALLOWED_ROLES?.trim() &&
    (!Array.isArray(roleIds) ||
      !roleIds.some(
        (id) =>
          typeof id === "string" &&
          allows(credentials.DISCORD_ALLOWED_ROLES, id),
      ))
  )
    return "role_not_allowed";
  if (!allows(users, source.userId)) return "user_not_allowed";
  const chats =
    credentials[`${prefix}_ALLOWED_CHATS`] ??
    credentials[`${prefix}_ALLOWED_CHANNELS`];
  const rawChatId = ["discord", "qqbot"].includes(platform)
    ? source.chatId?.replace(/^(?:channel|dm|group|guild|c2c):/, "")
    : source.chatId;
  return allows(chats, source.chatId) || allows(chats, rawChatId)
    ? null
    : "chat_not_allowed";
}

async function unauthorizedReply(
  connection: ChannelAccessConnection,
  source: ChannelSenderSource,
  behavior: string,
): Promise<string | undefined> {
  const { userId, chatId } = source;
  if (behavior === "ignore" || !userId || !chatId) return;
  return db.$transaction(async (tx) => {
    // The connection lock serializes the pending cap and per-sender reply across processes.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AgentChannelConnection"
      WHERE id = ${connection.id} AND "workspaceId" = ${connection.workspaceId} FOR UPDATE`;
    if (!locked.length) return;
    if (
      await tx.agentChannelSenderApproval.findUnique({
        where: {
          connectionId_platformUserId: {
            connectionId: connection.id,
            platformUserId: userId,
          },
        },
      })
    )
      return;
    const now = new Date();
    const status = behavior === "decline" ? "declined" : "pending";
    const live = await tx.agentChannelPairingRequest.findFirst({
      where: {
        connectionId: connection.id,
        platformUserId: userId,
        status,
        expiresAt: { gt: now },
      },
    });
    if (live) return;
    if (
      status === "pending" &&
      (await tx.agentChannelPairingRequest.count({
        where: {
          connectionId: connection.id,
          status: "pending",
          expiresAt: { gt: now },
        },
      })) >= 3
    )
      return;
    const code = pairingCode();
    await tx.agentChannelPairingRequest.create({
      data: {
        connectionId: connection.id,
        platformUserId: userId,
        userName: source.userName,
        chatId,
        code,
        status,
        expiresAt: new Date(
          now.getTime() + (status === "declined" ? 24 : 1) * 3_600_000,
        ),
      },
    });
    return status === "declined"
      ? "I can only reply to approved users."
      : `This bot needs approval before it can reply. Pairing code: ${code}. Ask a workspace admin to approve it in ToolPlane.`;
  });
}

export async function admitChannelSender(input: {
  connection: ChannelAccessConnection;
  credentials: Record<string, string>;
  source: ChannelSenderSource;
  roleIds?: unknown;
}): Promise<ChannelSenderDecision> {
  const { connection, credentials, source, roleIds } = input;
  const prefix = connection.platform.toUpperCase();
  const policy =
    credentials[
      `${prefix}_${source.chatType && source.chatType !== "dm" ? "GROUP" : "DM"}_POLICY`
    ];
  const admin = Boolean(
    source.userId && connection.adminUserIds.includes(source.userId),
  );
  let rule: DenialRule | null = null;
  if (connection.senderPolicyVersion === 1) {
    rule = legacyRule(connection.platform, credentials, source, roleIds);
  } else {
    const chats = ids(
      credentials[`${prefix}_ALLOWED_CHATS`] ??
        credentials[`${prefix}_ALLOWED_CHANNELS`],
    );
    const rawChatId = ["discord", "qqbot"].includes(connection.platform)
      ? source.chatId?.replace(/^(?:channel|dm|group|guild|c2c):/, "")
      : source.chatId;
    if (policy === "disabled") rule = "disabled";
    else if (
      chats.length &&
      !includesId(chats, source.chatId) &&
      !includesId(chats, rawChatId)
    )
      rule = "chat_not_allowed";
    else if (!admin) {
      const roles = ids(credentials.DISCORD_ALLOWED_ROLES);
      if (
        connection.platform === "discord" &&
        roles.length &&
        (!Array.isArray(roleIds) ||
          !roleIds.some(
            (id) => typeof id === "string" && includesId(roles, id),
          ))
      )
        rule = "role_not_allowed";
      else if (
        !(
          connection.openToAll ||
          policy === "open" ||
          includesId(ids(credentials[`${prefix}_ALLOWED_USERS`]), source.userId)
        )
      ) {
        const approved =
          source.userId &&
          (await db.agentChannelSenderApproval.findFirst({
            where: {
              connectionId: connection.id,
              platformUserId: source.userId,
              connection: { workspaceId: connection.workspaceId },
            },
            select: { id: true },
          }));
        if (!approved) rule = "user_not_allowed";
      }
    }
  }
  if (!rule) return { allowed: true, role: admin ? "admin" : "user" };
  const now = Date.now();
  const key = JSON.stringify([
    connection.id,
    source.userId ?? source.chatId,
    rule,
  ]);
  if ((rejectedAt.get(key) ?? 0) <= now - 60_000) {
    for (const [key, time] of rejectedAt)
      if (time <= now - 60_000) rejectedAt.delete(key);
    rejectedAt.set(key, now);
    // Sender IDs are platform routing metadata, not Agent content. An agentId on the
    // event (or an inherited request context) would reduce attributes to telemetry and
    // hide who was rejected, so record in a detached workspace/channel-only context.
    await withLogContext(
      { workspaceId: connection.workspaceId, channelId: connection.id },
      () =>
        recordEvent({
          domain: "channel",
          eventName: "channel.sender_rejected",
          level: "warn",
          outcome: "denied",
          workspaceId: connection.workspaceId,
          channelId: connection.id,
          attributes: {
            platform: connection.platform,
            userId: source.userId,
            userName: source.userName,
            chatId: source.chatId,
            chatType: source.chatType ?? "dm",
            rule,
          },
        }),
      true,
    );
  }
  const behavior =
    policy === "allowlist"
      ? "ignore"
      : policy === "pairing"
        ? "pair"
        : connection.unauthorizedDm;
  const reply =
    rule === "user_not_allowed" &&
    (!source.chatType || source.chatType === "dm")
      ? await unauthorizedReply(connection, source, behavior)
      : undefined;
  return { allowed: false, rule, ...(reply ? { reply } : {}) };
}

export function channelLegacyPolicyBackfill(
  platform: string,
  credentials: Record<string, string>,
) {
  const prefix = platform.toUpperCase();
  return (
    !credentials[`${prefix}_ALLOWED_USERS`]?.trim() &&
    credentials[`${prefix}_ALLOW_ALL_USERS`] !== "false" &&
    !["disabled", "allowlist", "pairing"].includes(
      credentials[`${prefix}_DM_POLICY`],
    )
  );
}

export async function backfillChannelSenderPolicies(): Promise<{
  migrated: number;
  skipped: number;
}> {
  const rows = await db.agentChannelConnection.findMany({
    where: { senderPolicyVersion: 1 },
  });
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const credentials = decryptSecretRecord(row.credentials);
    const openToAll = channelLegacyPolicyBackfill(row.platform, credentials);
    delete credentials[`${row.platform.toUpperCase()}_ALLOW_ALL_USERS`];
    const updated = await db.agentChannelConnection.updateMany({
      where: {
        id: row.id,
        workspaceId: row.workspaceId,
        senderPolicyVersion: 1,
        updatedAt: row.updatedAt,
      },
      data: {
        senderPolicyVersion: 2,
        openToAll,
        groupSessionsPerUser: !hostedRunnerSpec(row.platform),
        credentials: encryptSecretRecord(credentials) as Prisma.InputJsonValue,
      },
    });
    migrated += updated.count;
    skipped += 1 - updated.count;
  }
  await recordEvent({
    domain: "channel",
    eventName: "channel.sender_policy_backfilled",
    attributes: { migrated, skipped },
  });
  return { migrated, skipped };
}

type SenderAccessInput = {
  workspaceId: string;
  connectionId: string;
  actorId: string;
};
async function accessConnection(
  tx: Prisma.TransactionClient,
  input: SenderAccessInput,
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "AgentChannelConnection"
    WHERE id = ${input.connectionId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
  return Boolean(rows.length);
}
async function auditAccess(
  tx: Prisma.TransactionClient,
  input: SenderAccessInput,
  action: string,
  changes: Record<string, unknown>,
) {
  await writeAudit(tx, {
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    action: `agent.channel.${action}`,
    targetType: "AgentChannelConnection",
    targetId: input.connectionId,
    changes,
  });
}

export async function listChannelSenderAccess(
  workspaceId: string,
  connectionId: string,
) {
  const connection = await db.agentChannelConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true },
  });
  if (!connection) return null;
  const [pending, approved, rejectedRows] = await Promise.all([
    db.agentChannelPairingRequest.findMany({
      where: {
        connectionId,
        connection: { workspaceId },
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        platformUserId: true,
        userName: true,
        chatId: true,
        code: true,
        createdAt: true,
        expiresAt: true,
      },
    }),
    db.agentChannelSenderApproval.findMany({
      where: { connectionId, connection: { workspaceId } },
      orderBy: { createdAt: "desc" },
      select: {
        platformUserId: true,
        userName: true,
        createdAt: true,
        approvedBy: { select: { name: true, email: true } },
      },
    }),
    // recordEvent stores caller attributes under attributes.data.
    db.$queryRaw<
      {
        platformUserId: string;
        attributes: Prisma.JsonValue;
        count: bigint;
        lastAt: Date;
      }[]
    >`
      SELECT e.attributes->'data'->>'userId' AS "platformUserId",
        (array_agg(e.attributes->'data' ORDER BY e."createdAt" DESC, e.id DESC))[1] AS attributes,
        count(*) AS count, max(e."createdAt") AS "lastAt"
      FROM "LogEvent" e
      WHERE e."workspaceId" = ${workspaceId} AND e."channelId" = ${connectionId}
        AND e."eventName" = 'channel.sender_rejected' AND e.domain = 'channel'
        AND e."createdAt" >= ${new Date(Date.now() - 7 * 86_400_000)}
        AND e.attributes->'data'->>'userId' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "AgentChannelSenderApproval" a
          WHERE a."connectionId" = ${connectionId} AND a."platformUserId" = e.attributes->'data'->>'userId')
      GROUP BY e.attributes->'data'->>'userId' ORDER BY max(e."createdAt") DESC LIMIT 50`,
  ]);
  const rejected = rejectedRows.map((row) => {
    const attrs =
      row.attributes &&
      typeof row.attributes === "object" &&
      !Array.isArray(row.attributes)
        ? row.attributes
        : {};
    return {
      platformUserId: row.platformUserId,
      userName: typeof attrs.userName === "string" ? attrs.userName : null,
      chatId: typeof attrs.chatId === "string" ? attrs.chatId : null,
      chatType: typeof attrs.chatType === "string" ? attrs.chatType : null,
      rule: typeof attrs.rule === "string" ? attrs.rule : null,
      count: Number(row.count),
      lastAt: row.lastAt,
    };
  });
  return { pending, approved, rejected };
}

export async function approveChannelPairing(
  input: SenderAccessInput & { requestId: string },
): Promise<{ error?: string }> {
  const result = await db.$transaction(async (tx) => {
    if (!(await accessConnection(tx, input)))
      return { error: "Channel not found" };
    const request = await tx.agentChannelPairingRequest.findFirst({
      where: {
        id: input.requestId,
        connectionId: input.connectionId,
        connection: { workspaceId: input.workspaceId },
        status: "pending",
        expiresAt: { gt: new Date() },
      },
    });
    if (!request) return { error: "Pairing request not found or expired" };
    await tx.agentChannelSenderApproval.upsert({
      where: {
        connectionId_platformUserId: {
          connectionId: input.connectionId,
          platformUserId: request.platformUserId,
        },
      },
      create: {
        connectionId: input.connectionId,
        platformUserId: request.platformUserId,
        userName: request.userName,
        approvedById: input.actorId,
      },
      update: { userName: request.userName, approvedById: input.actorId },
    });
    await tx.agentChannelPairingRequest.update({
      where: { id: request.id },
      data: {
        status: "approved",
        decidedAt: new Date(),
        decidedById: input.actorId,
      },
    });
    await auditAccess(tx, input, "sender.approve", {
      platformUserId: request.platformUserId,
      requestId: request.id,
    });
    return { chatId: request.chatId };
  });
  if ("error" in result) return { error: result.error };
  // Approval stays durable for every notice outcome, including unavailable runners.
  await sendChannelNotice(
    input.connectionId,
    result.chatId,
    "Access approved. You can message this bot now.",
  );
  return {};
}

export async function dismissChannelPairing(
  input: SenderAccessInput & { requestId: string },
): Promise<{ error?: string }> {
  return db.$transaction(async (tx) => {
    if (!(await accessConnection(tx, input)))
      return { error: "Channel not found" };
    const changed = await tx.agentChannelPairingRequest.updateMany({
      where: {
        id: input.requestId,
        connectionId: input.connectionId,
        connection: { workspaceId: input.workspaceId },
        status: "pending",
      },
      data: {
        status: "dismissed",
        decidedAt: new Date(),
        decidedById: input.actorId,
      },
    });
    if (!changed.count) return { error: "Pairing request not found" };
    await auditAccess(tx, input, "sender.dismiss", {
      requestId: input.requestId,
    });
    return {};
  });
}

export async function allowChannelSender(
  input: SenderAccessInput & { platformUserId: string; userName?: string },
): Promise<{ error?: string }> {
  return db.$transaction(async (tx) => {
    if (!(await accessConnection(tx, input)))
      return { error: "Channel not found" };
    await tx.agentChannelSenderApproval.upsert({
      where: {
        connectionId_platformUserId: {
          connectionId: input.connectionId,
          platformUserId: input.platformUserId,
        },
      },
      create: {
        connectionId: input.connectionId,
        platformUserId: input.platformUserId,
        userName: input.userName,
        approvedById: input.actorId,
      },
      update: { userName: input.userName, approvedById: input.actorId },
    });
    await auditAccess(tx, input, "sender.allow", {
      platformUserId: input.platformUserId,
    });
    return {};
  });
}

export async function revokeChannelSender(
  input: SenderAccessInput & { platformUserId: string },
): Promise<{ error?: string }> {
  return db.$transaction(async (tx) => {
    if (!(await accessConnection(tx, input)))
      return { error: "Channel not found" };
    await tx.agentChannelSenderApproval.deleteMany({
      where: {
        connectionId: input.connectionId,
        platformUserId: input.platformUserId,
        connection: { workspaceId: input.workspaceId },
      },
    });
    await auditAccess(tx, input, "sender.revoke", {
      platformUserId: input.platformUserId,
    });
    return {};
  });
}
