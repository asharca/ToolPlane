import 'server-only';
import { randomUUID } from 'node:crypto';
import { AgentCard } from '@a2a-js/sdk';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { encryptSecretText, decryptSecretText } from '@/lib/security/secrets';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { writeAudit } from '@/lib/observability/audit';
import { A2AHttpError } from './principal';
import { assertLocalActor } from './local-policy';
import type { ConsoleActor } from './console-service';
import { discoverRemoteCard } from './remote-client';
import { remotePair } from './remote-network';

const Id = z.string().min(1).max(200);
const Token = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
export const RemoteAgentAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), name: z.string().trim().min(1).max(100),
    cardUrl: z.string().url().max(2000), rpcUrl: z.string().url().max(2000), token: Token.optional() }).strict(),
  z.object({ action: z.literal('configure'), id: Id, revision: z.number().int().positive(),
    enabled: z.boolean().optional(), allowCurrentAgent: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('replace-key'), id: Id, revision: z.number().int().positive(), token: Token }).strict(),
]);
export type RemoteAgentAction = z.infer<typeof RemoteAgentAction>;
const safeSelect = { id: true, name: true, cardUrl: true, rpcUrl: true, enabled: true, revision: true, allowedAgentIds: true } as const;
export type RemoteAgentView = { canManage: boolean; agents: Array<{
  id: string; name: string; cardUrl: string; rpcUrl: string; enabled: boolean; revision: number; allowed: boolean;
}> };
export async function assertRemoteManager(tx: Prisma.TransactionClient, ctx: ConsoleActor) {
  await assertLocalActor(tx, ctx.workspaceId, ctx.actorId);
  if (!await tx.workspace.count({ where: { id: ctx.workspaceId, OR: [{ ownerId: ctx.actorId },
    { members: { some: { userId: ctx.actorId, role: 'admin' } } }] } })) throw new A2AHttpError(403, 'Workspace administrator required.');
  if (!await tx.agent.count({ where: { ...ORDINARY_AGENT_FILTER, id: ctx.agentId, workspaceId: ctx.workspaceId } })) throw new A2AHttpError(404, 'Agent unavailable.');
}
export async function remoteRegistryView(ctx: ConsoleActor): Promise<RemoteAgentView> {
  await assertLocalActor(db, ctx.workspaceId, ctx.actorId);
  if (!await db.agent.count({ where: { ...ORDINARY_AGENT_FILTER, id: ctx.agentId, workspaceId: ctx.workspaceId } })) throw new A2AHttpError(404, 'Agent unavailable.');
  let manager = false;
  try { await assertRemoteManager(db, ctx); manager = true; } catch (error) {
    if (!(error instanceof A2AHttpError) || error.status !== 403) throw error;
  }
  const rows = await db.remoteA2AAgent.findMany({ where: { workspaceId: ctx.workspaceId,
    ...(manager ? {} : { enabled: true, allowedAgentIds: { has: ctx.agentId } }) }, select: safeSelect,
    orderBy: { createdAt: 'asc' }, take: 100 });
  return { canManage: manager, agents: rows.map(({ allowedAgentIds, ...row }) => ({ ...row, allowed: allowedAgentIds.includes(ctx.agentId) })) };
}
function protect(token: string, workspaceId: string, id: string): Prisma.InputJsonValue {
  // Bind the encrypted payload to its row/workspace; copying envelopes cannot switch identity.
  return encryptSecretText(JSON.stringify({ token, workspaceId, id })) as Prisma.InputJsonValue;
}
export function remoteCredential(row: { id: string; workspaceId: string; credential: unknown }): string | undefined {
  if (!row.credential) return undefined;
  const value = JSON.parse(decryptSecretText(row.credential));
  if (value.id !== row.id || value.workspaceId !== row.workspaceId || !Token.safeParse(value.token).success) throw new Error('Remote credential binding mismatch');
  return value.token;
}
export async function mutateRemoteRegistry(ctx: ConsoleActor, raw: unknown, signal?: AbortSignal) {
  const input = RemoteAgentAction.parse(raw);
  await assertRemoteManager(db, ctx);
  // Discovery happens only after authorization, outside any long-running database transaction.
  let registration: { id: string; card: AgentCard; cardUrl: string; rpcUrl: string } | undefined;
  if (input.action === 'register') {
    if (await db.remoteA2AAgent.count({ where: { workspaceId: ctx.workspaceId } }) >= 100) throw new A2AHttpError(409, 'Remote Agent limit reached.');
    const pair = remotePair(input.cardUrl, input.rpcUrl);
    registration = { id: randomUUID(), ...pair, card: await discoverRemoteCard(pair.cardUrl, pair.rpcUrl, input.token, signal) };
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${ctx.workspaceId} FOR UPDATE`;
    await assertRemoteManager(tx, ctx);
    let id: string;
    if (input.action === 'register' && registration) {
      if (await tx.remoteA2AAgent.count({ where: { workspaceId: ctx.workspaceId } }) >= 100) throw new A2AHttpError(409, 'Remote Agent limit reached.');
      id = registration.id;
      await tx.remoteA2AAgent.create({ data: { id, workspaceId: ctx.workspaceId, name: input.name,
        cardUrl: registration.cardUrl, rpcUrl: registration.rpcUrl,
        card: AgentCard.toJSON(registration.card) as Prisma.InputJsonValue,
        credential: input.token ? protect(input.token, ctx.workspaceId, id) : Prisma.DbNull,
        enabled: false, allowedAgentIds: [] } });
    } else if (input.action !== 'register') {
      const row = await tx.remoteA2AAgent.findFirst({ where: { id: input.id, workspaceId: ctx.workspaceId, revision: input.revision } });
      if (!row) throw new A2AHttpError(409, 'Remote configuration changed. Refresh before retrying.');
      id = row.id;
      if (input.action === 'replace-key') {
        await tx.remoteA2AAgent.update({ where: { id }, data: { credential: protect(input.token, ctx.workspaceId, id), revision: { increment: 1 } } });
      } else {
        if (input.enabled) remotePair(row.cardUrl, row.rpcUrl);
        const ids = new Set(row.allowedAgentIds);
        if (input.allowCurrentAgent === true) ids.add(ctx.agentId);
        if (input.allowCurrentAgent === false) ids.delete(ctx.agentId);
        if (ids.size > 100) throw new A2AHttpError(409, 'Remote Agent authorization limit reached.');
        await tx.remoteA2AAgent.update({ where: { id }, data: { enabled: input.enabled, allowedAgentIds: [...ids].sort(), revision: { increment: 1 } } });
      }
    } else throw new A2AHttpError(400, 'Invalid remote Agent registration.');
    await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: `agent.a2a.remote.${input.action}`,
      targetType: 'RemoteA2AAgent', targetId: id });
    return { id };
  });
}
