import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { workSessionWorkingDirectory } from '@/lib/work/sessions';
import type { LocalA2AGrant } from './principal';

type Tx = Prisma.TransactionClient;
export type EntryKind = 'chat' | 'work' | 'channel' | 'control';
export type EntryIdentity = { kind: EntryKind; sourceId: string; channelId?: string };
const missing = () => new TaskNotFoundError();
/** Never infer a platform user from a channel sender or workspace owner. */
export async function createEntryPolicy(tx: Tx, grant: Pick<LocalA2AGrant, 'workspaceId' | 'agentId' | 'actorId'>, source: EntryIdentity): Promise<NonNullable<LocalA2AGrant['entryPolicy']>> {
  let authorization: unknown;
  let workingDirectory: string | undefined;
  if (source.kind === 'work') {
    const work = await tx.workSession.findFirst({ where: { id: source.sourceId, workspaceId: grant.workspaceId,
      agentId: grant.agentId, a2aActorId: grant.actorId }, select: { runtimeSnapshot: true, cancelRequestedAt: true, status: true } });
    if (!work || work.cancelRequestedAt || ['archived', 'cancelling', 'cancelled'].includes(work.status)) throw missing();
    workingDirectory = workSessionWorkingDirectory(work.runtimeSnapshot);
    authorization = [work.runtimeSnapshot, grant.actorId];
  } else {
    const conversation = await tx.conversation.findFirst({ where: { id: source.sourceId,
      agent: { workspaceId: grant.workspaceId }, agentId: grant.agentId }, select: { runtimeSessionKey: true,
        workSession: { select: { id: true } }, publicApiConversation: { select: { id: true } } } });
    if (!conversation || conversation.workSession || conversation.publicApiConversation) throw missing();
    if (source.kind === 'channel') {
      if (!source.channelId || !conversation.runtimeSessionKey?.startsWith(`channel:${source.channelId}:`)) throw missing();
      const channel = await tx.agentChannelConnection.findFirst({ where: { id: source.channelId, workspaceId: grant.workspaceId,
        agentId: grant.agentId, a2aActorId: grant.actorId, status: { in: ['running', 'starting', 'waiting_callback'] } },
        select: { agentId: true, sandboxId: true, platform: true, config: true, credentials: true, inboundTokenHash: true, a2aActorId: true } });
      if (!channel) throw new UnsupportedOperationError('An administrator must explicitly authorize a native channel operator in A2A settings.');
      // Store a digest, not a secret-bearing configuration snapshot.
      authorization = [channel, conversation.runtimeSessionKey];
    } else {
      if (conversation.runtimeSessionKey?.startsWith('channel:')) throw missing();
      authorization = [conversation.runtimeSessionKey, grant.actorId];
    }
  }
  return { ...source, sourceAgentId: grant.agentId, workingDirectory,
    binding: createHash('sha256').update(JSON.stringify([grant.workspaceId, grant.agentId, source, authorization])).digest('hex') };
}
export async function assertEntryPolicy(tx: Tx, grant: LocalA2AGrant) {
  const entry = grant.entryPolicy;
  if (!entry) return;
  const current = await createEntryPolicy(tx, { ...grant, agentId: entry.sourceAgentId }, {
    kind: entry.kind, sourceId: entry.sourceId, ...(entry.channelId ? { channelId: entry.channelId } : {}),
  });
  if (current.binding !== entry.binding || current.workingDirectory !== entry.workingDirectory) throw missing();
}
