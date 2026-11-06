import "server-only";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getAgentForRun } from "@/lib/agents/queries";
import { createConversation } from "@/lib/agents/mutations";
import { resolvePinnedAgent } from "./revisions";
import {
  upgradeAgentConversationRevision,
  AgentConversationRevisionError,
} from "./conversation-revisions";
import { TERMINAL } from "@/lib/a2a/model";

type ConversationWaiter = {
  operation: string;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};
const operationsGlobal = globalThis as unknown as {
  __conversationOperations?: Map<string, string>;
  __conversationOperationWaiters?: Map<string, ConversationWaiter[]>;
};
// ponytail: process-local admission matches the hosted runners; use shared leases with multiple coordinators.
operationsGlobal.__conversationOperations ??= new Map<string, string>();
const operations = operationsGlobal.__conversationOperations;
operationsGlobal.__conversationOperationWaiters ??= new Map<
  string,
  ConversationWaiter[]
>();
const operationWaiters = operationsGlobal.__conversationOperationWaiters;

export class ConversationOperationError extends Error {
  constructor(
    public code: "notFound" | "busy" | "notChannel" | "readOnly",
    public status = 409,
  ) {
    super(code);
  }
}

export function conversationOperationKey(conversation: {
  id: string;
  runtimeSessionKey?: string | null;
}) {
  return conversation.runtimeSessionKey?.startsWith("channel:")
    ? conversation.runtimeSessionKey
    : conversation.id;
}

export function acquireConversationOperation(
  key: string,
  operation = "chat",
): (() => void) | null {
  if (operations.has(key)) return null;
  return reserveConversationOperation(key, operation);
}

function reserveConversationOperation(
  key: string,
  operation: string,
): () => void {
  operations.set(key, operation);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    operations.delete(key);
    const queue = operationWaiters.get(key);
    const next = queue?.shift();
    if (!queue?.length) operationWaiters.delete(key);
    if (next) {
      next.signal?.removeEventListener("abort", next.onAbort);
      next.resolve(reserveConversationOperation(key, next.operation));
    }
  };
}

export async function waitForConversationOperation(
  key: string,
  signal?: AbortSignal,
  operation = "chat",
): Promise<() => void> {
  signal?.throwIfAborted();
  const release = acquireConversationOperation(key, operation);
  if (release) return release;
  return new Promise((resolve, reject) => {
    const waiter: ConversationWaiter = {
      operation,
      signal,
      resolve,
      reject,
      onAbort: () => {
        const queue = operationWaiters.get(key);
        const index = queue?.indexOf(waiter) ?? -1;
        if (index !== -1) queue?.splice(index, 1);
        if (!queue?.length) operationWaiters.delete(key);
        reject(signal?.reason);
      },
    };
    const queue = operationWaiters.get(key) ?? [];
    queue.push(waiter);
    operationWaiters.set(key, queue);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

export async function rotateChannelConversation(params: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  runtimeSessionKey?: string;
  onCreated?: (
    tx: Prisma.TransactionClient,
    conversationId: string,
  ) => Promise<void>;
}) {
  const conversation = await db.conversation.findFirst({
    where: {
      id: params.conversationId,
      agentId: params.agentId,
      agent: { workspaceId: params.workspaceId },
    },
    include: {
      workSession: true,
      publicApiConversation: { select: { id: true } },
    },
  });
  if (!conversation || conversation.publicApiConversation)
    throw new ConversationOperationError("notFound", 404);
  const liveAgent = await getAgentForRun(params.agentId, params.workspaceId);
  if (!liveAgent) throw new ConversationOperationError("notFound", 404);
  if (
    liveAgent.runtimeKind !== "pi-sdk" ||
    liveAgent.retiredAt ||
    conversation.legacyRevisionUnresolved ||
    !conversation.agentRevisionId
  )
    throw new ConversationOperationError("readOnly");
  await resolvePinnedAgent(liveAgent, conversation.agentRevisionId);
  const key = conversationOperationKey(conversation);
  if (!key.startsWith("channel:"))
    throw new ConversationOperationError("notChannel", 400);
  const release = acquireConversationOperation(key, "new");
  if (!release) throw new ConversationOperationError("busy");
  try {
    await assertChannelConversationIdle(conversation.id, params.workspaceId);
    if (conversation.workSession) {
      const work = await db.workSession.findUnique({
        where: { id: conversation.workSession.id },
      });
      if (work && ["queued", "running", "cancelling"].includes(work.status))
        throw new ConversationOperationError("busy");
    }
    const channel = await db.agentChannelConnection.findFirst({
      where: {
        id: key.split(":")[1],
        workspaceId: params.workspaceId,
        agentId: params.agentId,
      },
    });
    if (!channel) throw new ConversationOperationError("notFound", 404);
    if (
      params.runtimeSessionKey &&
      !params.runtimeSessionKey.startsWith(`channel:${channel.id}:`)
    )
      throw new ConversationOperationError("notChannel", 400);
    const created = await createConversation(
      params.workspaceId,
      params.agentId,
      conversation.title ?? undefined,
      { runtimeSessionKey: params.runtimeSessionKey ?? key },
      params.onCreated,
    );
    if (!created) throw new ConversationOperationError("notFound", 404);
    return { conversationId: created.id, compacted: false as const };
  } finally {
    release();
  }
}

/** Selection time overrides creation time without changing the persisted routing key. */
export async function channelConversationIds(
  agentId: string,
  workspaceId: string,
  sessionKey: string,
  limit = 10,
) {
  const rows = await db.$queryRaw<
    { id: string }[]
  >`SELECT c.id FROM "Conversation" c JOIN "Agent" a ON a.id=c."agentId" WHERE c."agentId"=${agentId} AND a."workspaceId"=${workspaceId} AND c."runtimeSessionKey"=${sessionKey} ORDER BY COALESCE(c."channelSelectedAt", c."createdAt") DESC, c.id DESC LIMIT ${Math.min(limit, 11)}`;
  return rows.map((row) => row.id);
}

export async function assertChannelConversationIdle(
  conversationId: string,
  workspaceId: string,
) {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId } },
    include: { workSession: true },
  });
  if (!conversation) throw new ConversationOperationError("notFound", 404);
  if (
    conversation.workSession &&
    ["queued", "running", "cancelling"].includes(
      conversation.workSession.status,
    )
  )
    throw new ConversationOperationError("busy");
  const active = await db.a2ATask.count({
    where: {
      state: { notIn: TERMINAL },
      context: {
        workspaceId,
        entryBindings: {
          some: {
            sourceId: conversationId,
            kind: { in: ["channel", "chat", "control"] },
          },
        },
      },
    },
  });
  if (active) throw new ConversationOperationError("busy");
}

export async function upgradeChannelConversations(input: {
  workspaceId: string;
  connectionId: string;
}): Promise<{ upgraded: number; skipped: number }> {
  const connection = await db.agentChannelConnection.findFirst({
    where: { id: input.connectionId, workspaceId: input.workspaceId },
    include: { agent: true },
  });
  if (!connection?.agent) throw new ConversationOperationError("notFound", 404);
  const rows = await db.conversation.findMany({
    where: {
      agentId: connection.agent.id,
      agent: { workspaceId: input.workspaceId },
      runtimeSessionKey: { startsWith: `channel:${connection.id}:` },
      agentRevision: {
        version: { lt: connection.agent.currentRevisionVersion },
      },
    },
    select: { id: true },
  });
  let upgraded = 0,
    skipped = 0;
  for (const row of rows) {
    try {
      await upgradeAgentConversationRevision({
        workspaceId: input.workspaceId,
        agentId: connection.agent.id,
        conversationId: row.id,
        targetVersion: connection.agent.currentRevisionVersion,
      });
      upgraded += 1;
    } catch (error) {
      if (
        error instanceof AgentConversationRevisionError &&
        error.code === "busy"
      )
        skipped += 1;
      else throw error;
    }
  }
  return { upgraded, skipped };
}
