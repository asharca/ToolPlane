import "server-only";
import { db } from "@/lib/db";
import { getAgentForRun } from "@/lib/agents/queries";
import { createConversation } from "@/lib/agents/mutations";
import { resolvePinnedAgent } from "./revisions";

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
    if (conversation.workSession) {
      const work = await db.workSession.findUnique({
        where: { id: conversation.workSession.id },
      });
      if (
        work &&
        ["queued", "running", "waiting_approval", "cancelling"].includes(
          work.status,
        )
      )
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
    const created = await createConversation(
      params.workspaceId,
      params.agentId,
      conversation.title ?? undefined,
      { runtimeSessionKey: key },
    );
    if (!created) throw new ConversationOperationError("notFound", 404);
    return { conversationId: created.id, compacted: false as const };
  } finally {
    release();
  }
}
