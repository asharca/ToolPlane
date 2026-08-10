import 'server-only';
import type { AgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { db } from '@/lib/db';
import { getAgentEndpointRuntimeForExecution } from '@/lib/agents/queries';
import { acquireHermesRuntimeWriteLease } from '@/lib/agents/hermes/runtime';
import { deleteHermesSession } from '@/lib/agents/hermes/client';
import { AgentApiError, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { AGENT_API_MAX_TRANSCRIPT_CHARACTERS } from '@/lib/agents/public-api/body';

export const AGENT_API_DEFAULT_TRANSCRIPT_PAGE_SIZE = 20;
export const AGENT_API_MAX_TRANSCRIPT_PAGE_SIZE = 100;

function textFromParts(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => (
    part && typeof part === 'object'
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : []
  )).join('');
}

function conversationWhere(
  principal: AgentApiPrincipal,
  publicId: string,
) {
  return {
    ...conversationScopeWhere(principal, publicId),
    deletingAt: null,
  };
}

function conversationScopeWhere(
  principal: AgentApiPrincipal,
  publicId: string,
) {
  return {
    publicId,
    endpointId: principal.endpointId,
    clientId: principal.clientId,
    ...(principal.subjectHash ? { subjectHash: principal.subjectHash } : {}),
  };
}

export async function getAgentConversationForPrincipal(
  principal: AgentApiPrincipal,
  publicId: string,
  options: { limit?: number; after?: string | null } = {},
) {
  const wrapper = await db.agentPublicConversation.findFirst({
    where: conversationWhere(principal, publicId),
    select: {
      publicId: true,
      createdAt: true,
      revision: { select: { version: true } },
      conversationId: true,
    },
  });
  if (!wrapper) return null;
  const limit = Math.min(
    AGENT_API_MAX_TRANSCRIPT_PAGE_SIZE,
    Math.max(1, options.limit ?? AGENT_API_DEFAULT_TRANSCRIPT_PAGE_SIZE),
  );
  const after = options.after?.trim() || null;
  if (after) {
    const cursor = await db.message.findFirst({
      where: { id: after, conversationId: wrapper.conversationId },
      select: { id: true },
    });
    if (!cursor) throw new AgentApiError('invalid_request', 'The conversation cursor is invalid.', 400);
  }
  const rows = await db.message.findMany({
    where: { conversationId: wrapper.conversationId, role: { in: ['user', 'assistant'] } },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    take: limit + 1,
    select: { id: true, role: true, createdAt: true, textCharacters: true },
  });
  const selectedRows: typeof rows = [];
  let selectedCharacters = 0;
  for (const row of rows.slice(0, limit)) {
    if (
      selectedRows.length
      && selectedCharacters + row.textCharacters > AGENT_API_MAX_TRANSCRIPT_CHARACTERS
    ) break;
    selectedCharacters += row.textCharacters;
    selectedRows.push(row);
  }
  const fullRows = selectedRows.length
    ? await db.message.findMany({
        where: {
          conversationId: wrapper.conversationId,
          id: { in: selectedRows.map((row) => row.id) },
        },
        select: { id: true, parts: true },
      })
    : [];
  const partsById = new Map(fullRows.map((row) => [row.id, row.parts]));
  const messages: Array<{
    id: string;
    role: string;
    content: string;
    created_at: number;
  }> = [];
  for (const message of selectedRows) {
    const text = textFromParts(partsById.get(message.id));
    if (!text) continue;
    messages.push({
      id: message.id,
      role: message.role,
      content: text.slice(0, AGENT_API_MAX_TRANSCRIPT_CHARACTERS),
      created_at: Math.floor(message.createdAt.getTime() / 1_000),
    });
  }
  const hasMore = rows.length > selectedRows.length;
  return {
    id: wrapper.publicId,
    object: 'agent.conversation',
    endpoint_id: principal.endpointPublicId,
    endpoint_revision: wrapper.revision.version,
    created_at: Math.floor(wrapper.createdAt.getTime() / 1_000),
    messages,
    has_more: hasMore,
    next_cursor: hasMore ? messages.at(-1)?.id ?? after : null,
  };
}

/**
 * The tombstone is irreversible: the transcript is deleted transactionally
 * before best-effort Hermes cleanup. A broken/stopped runtime can delay volume
 * cleanup, but it can never make user-deleted or expired data public again.
 */
export async function deleteAgentConversationForPrincipal(
  principal: AgentApiPrincipal,
  publicId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const locked = await db.$transaction(async (tx) => {
    const wrapper = await tx.agentPublicConversation.findFirst({
      where: conversationScopeWhere(principal, publicId),
      include: {
        endpoint: { select: { workspaceId: true } },
        runtimeAllocation: true,
        conversation: { select: { id: true, runtimeSessionId: true, runtimeSessionKey: true } },
      },
    });
    if (!wrapper) return null;
    await tx.$queryRaw`SELECT "id" FROM "AgentPublicConversation" WHERE "id" = ${wrapper.id} FOR UPDATE`;
    const busy = await tx.agentRun.count({
      where: { publicConversationId: wrapper.id, status: { in: ['provisioning', 'running'] } },
    });
    if (busy) throw new AgentApiError('conversation_busy', publicErrorMessage('conversation_busy'), 409, 1);
    if (!wrapper.deletingAt) {
      const marked = await tx.agentPublicConversation.updateMany({
        where: { id: wrapper.id, deletingAt: null },
        data: { deletingAt: new Date() },
      });
      if (marked.count !== 1) return null;
    }
    await tx.message.deleteMany({ where: { conversationId: wrapper.conversation.id } });
    await tx.agentPublicConversation.updateMany({
      where: { id: wrapper.id, deletingAt: { not: null } },
      data: { storedCharacters: 0 },
    });
    return wrapper;
  }, { isolationLevel: 'Serializable' });
  if (!locked) return false;

  const runtimeAgentId = locked.runtimeAllocation.runtimeAgentId;
  const agent = runtimeAgentId
    ? await getAgentEndpointRuntimeForExecution(
        locked.endpoint.workspaceId,
        runtimeAgentId,
        locked.runtimeAllocation.id,
      )
    : null;
  const sessionId = locked.conversation.runtimeSessionId;
  const sessionKey = locked.conversation.runtimeSessionKey;
  if (!agent?.runtime || !sessionId || !sessionKey) {
    await db.agentPublicConversation.updateMany({
      where: { id: locked.id, deletingAt: { not: null } },
      data: { updatedAt: new Date() },
    });
    return true;
  }

  const lease = acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id);
  if (!lease) {
    await db.agentPublicConversation.updateMany({
      where: { id: locked.id, deletingAt: { not: null } },
      data: { updatedAt: new Date() },
    });
    return true;
  }
  try {
    await deleteHermesSession({
      agent,
      sessionId,
      sessionKey,
      writeLease: lease,
      signal,
    });
    await db.conversation.deleteMany({ where: { id: locked.conversation.id, agentId: agent.id } });
    return true;
  } catch {
    await db.agentPublicConversation.updateMany({
      where: { id: locked.id, deletingAt: { not: null } },
      data: { updatedAt: new Date() },
    }).catch(() => undefined);
    return true;
  } finally {
    lease.release();
  }
}
