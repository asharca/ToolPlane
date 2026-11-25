import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { appendAgentChannelLog } from "./channel-runtime-logs";
import { runPersistedChannelCallback } from "./message-service";
import { runtimeCanOperate } from "@/lib/runtime/ownership-state";
import { logSystemEvent } from "@/lib/observability/system";
import { queueRunningChannelMessages } from "./channel-message-queue";
import { MAX_INBOUND_PAYLOAD_BYTES } from "./channels/constants";

const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const MAX_QUEUED = 200;
type Handler = (
  payload: Prisma.JsonValue,
  dedupeKey: string,
) => Promise<unknown>;
const MAX_DRAINS = 8;
type Slots = { available: number; waiters: (() => void)[] };
type InboundState = {
  handlers: Map<string, Handler>;
  active: Map<string, Promise<void>>;
  regularDrains: Slots;
  approvalDrains: Slots;
  recovery?: Promise<void>;
  timer?: NodeJS.Timeout;
  lastRetention: number;
  abort: AbortController;
};
const globals = globalThis as typeof globalThis & {
  __toolplaneInbound?: InboundState;
};
globals.__toolplaneInbound ??= {
  handlers: new Map(),
  active: new Map(),
  // A waiting approval holds its normal drain. Reserve one slot for decisions.
  regularDrains: { available: MAX_DRAINS - 1, waiters: [] },
  approvalDrains: { available: 1, waiters: [] },
  lastRetention: 0,
  abort: new AbortController(),
};
const inbound: InboundState = globals.__toolplaneInbound;
const { handlers, active, regularDrains, approvalDrains } = inbound;

export function startChannelInboundRecovery() {
  if (inbound.abort.signal.aborted) inbound.abort = new AbortController();
  if (inbound.timer) return;
  inbound.timer = setInterval(() => {
    if (runtimeCanOperate()) void recoverChannelInboundEvents().catch(() => {});
  }, 30_000);
  inbound.timer.unref();
}

export async function stopChannelInboundRecovery() {
  inbound.abort.abort();
  clearInterval(inbound.timer);
  inbound.timer = undefined;
  await inbound.recovery?.catch(() => {});
  await Promise.allSettled([...active.values()]);
}

export function channelInboundDedupeKey(
  messageId: string | undefined,
  payload: unknown,
  messageScope?: string,
) {
  // Telegram message_id is unique within a chat, not across a bot connection.
  return messageId
    ? messageScope
      ? `${messageScope}:${messageId}`
      : messageId
    : createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class ChannelInboundConflictError extends Error {
  constructor() {
    super("Channel message ID was reused with different content.");
  }
}

/** Payloads are normalized message events, never connection credentials/platform envelopes. */
export async function persistChannelInboundEvent(input: {
  connectionId: string;
  workspaceId: string;
  dedupeKey: string;
  queueKey: string;
  kind: "hosted" | "callback";
  payload: Prisma.InputJsonValue;
}) {
  if (
    Buffer.byteLength(JSON.stringify(input.payload)) > MAX_INBOUND_PAYLOAD_BYTES
  )
    throw new Error("Channel inbound payload exceeds the attachment limit.");
  return db.$transaction(async (tx) => {
    const owner = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "AgentChannelConnection" WHERE id=${input.connectionId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
    if (!owner.length) throw new Error("Channel not found.");
    const duplicate = await tx.agentChannelInboundEvent.findUnique({
      where: {
        connectionId_dedupeKey: {
          connectionId: input.connectionId,
          dedupeKey: input.dedupeKey,
        },
      },
    });
    if (duplicate) {
      const payload =
        duplicate.payload &&
        typeof duplicate.payload === "object" &&
        !Array.isArray(duplicate.payload)
          ? { ...duplicate.payload }
          : duplicate.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload))
        delete payload.result;
      if (
        duplicate.kind !== input.kind ||
        !isDeepStrictEqual(payload, input.payload)
      )
        throw new ChannelInboundConflictError();
      return { event: duplicate, duplicate: true };
    }
    const queued = await tx.agentChannelInboundEvent.count({
      where: {
        connectionId: input.connectionId,
        status: { in: ["queued", "processing"] },
      },
    });
    if (queued >= MAX_QUEUED) {
      appendAgentChannelLog(
        input.connectionId,
        "error",
        "Channel durable inbound queue overflow.",
      );
      throw new Error("Channel message queue is full.");
    }
    const { workspaceId: _workspaceId, ...data } = input;
    return {
      event: await tx.agentChannelInboundEvent.create({ data }),
      duplicate: false,
    };
  });
}

export function registerChannelInboundHandler(
  connectionId: string,
  handler: Handler,
) {
  handlers.set(connectionId, handler);
  return () => {
    if (handlers.get(connectionId) === handler) handlers.delete(connectionId);
  };
}

export async function processChannelInboundQueue(
  connectionId: string,
  queueKey: string,
) {
  const key = `${connectionId}:${queueKey}`;
  const pending = active.get(key);
  if (pending) {
    await queueRunningChannelMessages(connectionId, queueKey);
    return pending;
  }
  const operation = (async () => {
    const slots =
      queueKey === `approval:${connectionId}` ? approvalDrains : regularDrains;
    if (slots.available) slots.available--;
    else {
      const { promise, resolve } = Promise.withResolvers<void>();
      slots.waiters.push(resolve);
      await promise;
    }
    try {
      await drain(connectionId, queueKey);
    } finally {
      active.delete(key);
      const next = slots.waiters.shift();
      if (next) next();
      else slots.available++;
    }
  })();
  active.set(key, operation);
  return operation;
}

async function drain(connectionId: string, queueKey: string) {
  while (!inbound.abort.signal.aborted && runtimeCanOperate()) {
    const now = new Date();
    const row = await db.agentChannelInboundEvent.findFirst({
      where: {
        connectionId,
        queueKey,
        status: { in: ["queued", "processing"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (
      !row ||
      (row.status === "processing" && row.leaseUntil && row.leaseUntil > now)
    )
      return;
    const handler =
      row.kind === "hosted"
        ? handlers.get(connectionId)
        : row.kind === "callback"
          ? async (payload: Prisma.JsonValue, dedupeKey: string) => {
              return runPersistedChannelCallback(
                connectionId,
                payload,
                inbound.abort.signal,
                dedupeKey,
              );
            }
          : undefined;
    if (!handler) return;
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.agentChannelInboundEvent.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: {
          status: "failed",
          leaseUntil: null,
          lastError: "Inbound attempt limit reached.",
        },
      });
      continue;
    }
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const claim = await db.agentChannelInboundEvent.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { status: "processing", attempts: { increment: 1 }, leaseUntil },
    });
    if (!claim.count) continue;
    let lease = leaseUntil;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          const next = new Date(Date.now() + LEASE_MS);
          const renewed = await db.agentChannelInboundEvent.updateMany({
            where: { id: row.id, status: "processing", leaseUntil: lease },
            data: { leaseUntil: next },
          });
          if (renewed.count) lease = next;
        })
        .catch((error) => {
          logSystemEvent("channel.inbound.lease_renewal_failed", {
            domain: "channel",
            channelId: connectionId,
            error,
          });
        });
    }, LEASE_MS / 3);
    timer.unref?.();
    try {
      const result = await handler(row.payload, row.dedupeKey);
      clearInterval(timer);
      await heartbeat;
      await db.agentChannelInboundEvent.updateMany({
        where: { id: row.id, status: "processing", leaseUntil: lease },
        data: {
          status: "done",
          leaseUntil: null,
          lastError: null,
          ...(row.kind === "callback"
            ? {
                payload: JSON.parse(
                  JSON.stringify({ ...(row.payload as object), result }),
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    } catch (error) {
      clearInterval(timer);
      await heartbeat;
      const detached =
        inbound.abort.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      await db.agentChannelInboundEvent.updateMany({
        where: { id: row.id, status: "processing", leaseUntil: lease },
        data: {
          status: detached
            ? "queued"
            : row.attempts + 1 >= MAX_ATTEMPTS
              ? "failed"
              : "queued",
          leaseUntil: null,
          lastError: detached ? null : "Channel inbound processing failed.",
        },
      });
      if (detached) return;
      logSystemEvent("channel.inbound.processing_failed", {
        domain: "channel",
        channelId: connectionId,
        error,
      });
      appendAgentChannelLog(
        connectionId,
        "error",
        "Durable channel inbound processing failed.",
      );
    }
  }
}

export function recoverChannelInboundEvents(connectionId?: string) {
  if (connectionId) return recover(connectionId);
  inbound.recovery ??= recover().finally(() => {
    inbound.recovery = undefined;
  });
  return inbound.recovery;
}

async function recover(connectionId?: string) {
  try {
    let cursor: { connectionId: string; queueKey: string } | undefined;
    const cutoff = new Date();
    while (!inbound.abort.signal.aborted && runtimeCanOperate()) {
      const where: Prisma.AgentChannelInboundEventWhereInput = {
        connectionId,
        OR: [
          { status: "queued" },
          { status: "processing", leaseUntil: { lte: cutoff } },
        ],
        ...(cursor && {
          AND: {
            OR: [
              { connectionId: { gt: cursor.connectionId } },
              {
                connectionId: cursor.connectionId,
                queueKey: { gt: cursor.queueKey },
              },
            ],
          },
        }),
      };
      const keys = await db.agentChannelInboundEvent.groupBy({
        by: ["connectionId", "queueKey"],
        where,
        orderBy: [{ connectionId: "asc" }, { queueKey: "asc" }],
        take: 64,
      });
      for (
        let index = 0;
        index < keys.length && !inbound.abort.signal.aborted;
        index += MAX_DRAINS
      ) {
        await Promise.all(
          keys
            .slice(index, index + MAX_DRAINS)
            .map((key) =>
              processChannelInboundQueue(key.connectionId, key.queueKey),
            ),
        );
      }
      if (keys.length < 64) break;
      cursor = keys[keys.length - 1];
    }
    if (
      connectionId ||
      inbound.abort.signal.aborted ||
      !runtimeCanOperate() ||
      Date.now() - inbound.lastRetention < 3_600_000
    )
      return;
    await db.agentChannelInboundEvent.deleteMany({
      where: {
        status: { in: ["done", "failed"] },
        updatedAt: { lt: new Date(Date.now() - 7 * 86400_000) },
      },
    });
    inbound.lastRetention = Date.now();
  } catch (error) {
    logSystemEvent("channel.inbound.recovery_failed", {
      domain: "channel",
      channelId: connectionId,
      error,
    });
    throw error;
  }
}
