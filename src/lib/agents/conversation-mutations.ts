import "server-only";
import { selectNewSessionRevision } from "@/lib/agents/evolution/rollout-selection";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { deleteAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";

export type ConversationRuntimeSession = {
  runtimeSessionId: string;
  runtimeSessionKey: string;
};

function nonEmptyString(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function defaultConversationRuntimeSession(
  agentId: string,
  conversationId: string,
  overrides: Partial<ConversationRuntimeSession> = {},
): ConversationRuntimeSession {
  const runtimeSessionId =
    nonEmptyString(overrides.runtimeSessionId) || conversationId;
  return {
    runtimeSessionId,
    runtimeSessionKey:
      nonEmptyString(overrides.runtimeSessionKey) ||
      `agent:${agentId}:console:${runtimeSessionId}`,
  };
}

export async function createConversation(
  workspaceId: string,
  agentId: string,
  title?: string,
  runtimeSession?: Partial<ConversationRuntimeSession>,
  onCreated?: (
    tx: Prisma.TransactionClient,
    conversationId: string,
  ) => Promise<void>,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) return null;
    const revision = await selectNewSessionRevision(tx, agent.id);
    const conversation = await tx.conversation.create({
      data: {
        agentId,
        title: title ?? null,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const selected = await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(
        agent.id,
        conversation.id,
        runtimeSession,
      ),
    });
    await onCreated?.(tx, selected.id);
    return selected;
  });
}

export async function renameConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: {
      id: true,
      title: true,
      publicApiConversation: { select: { id: true } },
      workSession: { select: { id: true } },
    },
  });
  if (
    !conversation ||
    conversation.title?.startsWith("msg:") ||
    conversation.publicApiConversation ||
    conversation.workSession
  )
    return false;
  const updated = await db.conversation.updateMany({
    where: { id: conversation.id, agentId, agent: { workspaceId } },
    data: { title },
  });
  return updated.count === 1;
}

export async function deleteConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: {
      id: true,
      title: true,
      publicApiConversation: { select: { id: true } },
      workSession: { select: { id: true } },
    },
  });
  if (
    !conversation ||
    conversation.title?.startsWith("msg:") ||
    conversation.publicApiConversation ||
    conversation.workSession
  )
    return false;
  await deleteAgentConversationSandboxes(
    { workspaceId, agentId, conversationId },
    async () => {
      await db.conversation.deleteMany({
        where: { id: conversation.id, agentId, agent: { workspaceId } },
      });
    },
  );
  return true;
}

// Conversations created before runtime session aliases existed are initialized
// lazily on their first runtime request. The nullable-only updates ensure a
// concurrent request never overwrites an alias already chosen by another one.
export async function ensureConversationRuntimeSession(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  fallback: Partial<ConversationRuntimeSession> = {},
): Promise<ConversationRuntimeSession | null> {
  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, agentId, agent: { workspaceId } },
      select: { id: true, runtimeSessionId: true, runtimeSessionKey: true },
    });
    if (!conversation) return null;

    const desired = defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(conversation.runtimeSessionId) ||
        nonEmptyString(fallback.runtimeSessionId) ||
        conversation.id,
      {
        runtimeSessionKey:
          conversation.runtimeSessionKey ?? fallback.runtimeSessionKey,
      },
    );
    if (conversation.runtimeSessionId === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionId: null },
        data: { runtimeSessionId: desired.runtimeSessionId },
      });
    }
    if (conversation.runtimeSessionKey === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionKey: null },
        data: { runtimeSessionKey: desired.runtimeSessionKey },
      });
    }
    const resolved = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { runtimeSessionId: true, runtimeSessionKey: true },
    });
    return defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(resolved?.runtimeSessionId) || desired.runtimeSessionId,
      {
        runtimeSessionKey:
          resolved?.runtimeSessionKey ?? desired.runtimeSessionKey,
      },
    );
  });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  parts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    if (role === "user") {
      const title = conversationTitleFromParts(parts);
      if (title) {
        // Claim the title before inserting the first user message. Concurrent
        // callers serialize on the conversation row, so exactly one can
        // observe a null title with no prior user messages.
        await tx.conversation.updateMany({
          where: {
            id: conversationId,
            title: null,
            messages: {
              none: { role: "user" },
            },
          },
          data: { title },
        });
      }
    }
    return tx.message.create({ data: { conversationId, role, parts } });
  });
}

export async function appendConversationTurn(
  conversationId: string,
  userParts: Prisma.InputJsonValue,
  assistantParts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    const title = conversationTitleFromParts(userParts);
    if (title) {
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          title: null,
          messages: { none: { role: "user" } },
        },
        data: { title },
      });
    }

    // PostgreSQL's now() is stable for an entire transaction. Supply adjacent
    // timestamps so the existing createdAt ordering always keeps the pair in
    // user/assistant order while both writes still commit atomically.
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    const user = await tx.message.create({
      data: {
        conversationId,
        role: "user",
        parts: userParts,
        createdAt: userCreatedAt,
      },
    });
    const assistant = await tx.message.create({
      data: {
        conversationId,
        role: "assistant",
        parts: assistantParts,
        createdAt: assistantCreatedAt,
      },
    });
    return { user, assistant };
  });
}
