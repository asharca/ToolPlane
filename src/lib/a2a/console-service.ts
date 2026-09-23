import 'server-only';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import { generateAgentApiKey, hashAgentApiKey, agentApiKeyPrefix } from '@/lib/agents/public-api/auth';
import { runtimeEnv } from '@/lib/runtime-env';
import { writeAudit } from '@/lib/observability/audit';
import { assertLocalActor, localTarget } from './local-policy';
import { A2AHttpError, A2A_SCOPES } from './principal';
import { a2aConnectionInfo, type A2AConsoleView } from './connection-info';

type Tx = Prisma.TransactionClient;
export type ConsoleActor = { workspaceId: string; actorId: string; agentId: string; slug: string };
const Id = z.string().min(1).max(200);
export const A2AConsoleAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set-channel-operator'), connectionId: Id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('set-local'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('set-public'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('create-client'), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('create-key'), clientId: Id }).strict(),
  z.object({ action: z.literal('revoke-key'), keyId: Id }).strict(),
]);
export type A2AConsoleAction = z.infer<typeof A2AConsoleAction>;
const isA2AClient = (scopes: string[]) => scopes.length > 0 && scopes.every((s) => (A2A_SCOPES as readonly string[]).includes(s));

async function canManage(tx: Tx, ctx: ConsoleActor) {
  return Boolean(await tx.workspace.count({ where: { id: ctx.workspaceId, status: 'active', owner: { status: 'active' },
    OR: [{ ownerId: ctx.actorId }, { members: { some: { userId: ctx.actorId, role: 'admin', user: { status: 'active' } } } }] } })
    && await tx.user.count({ where: { id: ctx.actorId, status: 'active' } }));
}

export async function getA2AConsoleView(ctx: ConsoleActor): Promise<A2AConsoleView> {
  await assertLocalActor(db, ctx.workspaceId, ctx.actorId);
  const agent = await db.agent.findFirst({ where: { ...ORDINARY_AGENT_FILTER, id: ctx.agentId, workspaceId: ctx.workspaceId },
    select: { runtimeKind: true, a2aInternalEnabled: true, providerId: true, model: true,
      sandboxes: { select: { sandbox: { select: { kind: true, network: true, workspaceId: true } } } } } });
  if (!agent) throw new A2AHttpError(404, 'Agent unavailable.');
  const manager = await canManage(db, ctx);
  const endpoint = await db.agentEndpoint.findFirst({ where: { workspaceId: ctx.workspaceId, sourceAgentId: ctx.agentId },
    select: { id: true, publicId: true, status: true, a2aEnabled: true, currentRevision: { select: { version: true } } } });
  const clients = manager && endpoint ? await db.agentApiClient.findMany({ where: { endpointId: endpoint.id },
    orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, name: true, status: true, scopes: true,
      keys: { orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, name: true, prefix: true, revokedAt: true, expiresAt: true } } } }) : [];
  let connections: A2AConsoleView['connections'] = null;
  try { connections = a2aConnectionInfo(runtimeEnv('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000', ctx.slug, ctx.agentId, endpoint?.publicId); }
  catch { /* Return a safe configuration warning, not Host-derived URLs. */ }
  const supported = isDedicatedSandboxRuntimeKind(agent.runtimeKind);
  const sandbox = agent.sandboxes.length === 1 ? agent.sandboxes[0].sandbox : null;
  const channels = manager && supported ? await db.agentChannelConnection.findMany({ where: { workspaceId: ctx.workspaceId, agentId: ctx.agentId },
    take: 100, orderBy: { name: 'asc' }, select: { id: true, name: true, platform: true, a2aActorId: true } }) : [];
  return { canManage: manager, connections, channels: channels.map((channel) => ({ id: channel.id, name: channel.name,
    platform: channel.platform, enabled: Boolean(channel.a2aActorId), mine: channel.a2aActorId === ctx.actorId })),
    local: { enabled: agent.a2aInternalEnabled, supported,
      ready: supported && Boolean(agent.providerId && agent.model && sandbox?.kind === 'docker' && sandbox.network !== 'none' && sandbox.workspaceId === ctx.workspaceId) },
    endpoint: endpoint ? { id: endpoint.publicId, enabled: endpoint.a2aEnabled,
      ready: endpoint.status === 'active' && Boolean(endpoint.currentRevision), revision: endpoint.currentRevision?.version ?? null,
      clients: clients.filter((client) => isA2AClient(client.scopes)).map((client) => ({ id: client.id, name: client.name, status: client.status,
        keys: client.keys.map((key) => ({ ...key, revokedAt: key.revokedAt?.toISOString() ?? null, expiresAt: key.expiresAt?.toISOString() ?? null })) })) } : null,
  };
}

/** Browser transport does not own authorization. Every mutation revalidates inside its transaction. */
export async function mutateA2AConsole(ctx: ConsoleActor, input: A2AConsoleAction): Promise<{ token?: string; clientId?: string }> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${ctx.workspaceId} FOR UPDATE`;
    if (!await canManage(tx, ctx)) throw new A2AHttpError(403, 'Workspace owner or administrator required.');
    const agent = await tx.agent.findFirst({ where: { ...ORDINARY_AGENT_FILTER, id: ctx.agentId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!agent) throw new A2AHttpError(404, 'Agent unavailable.');
    if (input.action === 'set-channel-operator') {
      const channel = await tx.agentChannelConnection.findFirst({ where: { id: input.connectionId, workspaceId: ctx.workspaceId, agentId: ctx.agentId }, select: { id: true } });
      if (!channel) throw new A2AHttpError(404, 'Channel unavailable.');
      if (input.enabled) await localTarget(tx, ctx.workspaceId, ctx.agentId);
      await tx.agentChannelConnection.update({ where: { id: channel.id }, data: { a2aActorId: input.enabled ? ctx.actorId : null } });
      await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agent.a2a.channel_operator', targetType: 'AgentChannelConnection',
        targetId: channel.id, changes: { enabled: input.enabled, actorId: input.enabled ? ctx.actorId : null } });
      return {};
    }
    if (input.action === 'set-local') {
      await tx.agent.update({ where: { id: agent.id }, data: { a2aInternalEnabled: input.enabled } });
      // Validate after setting within this transaction; invalid capability configuration rolls back.
      if (input.enabled) {
        try { await localTarget(tx, ctx.workspaceId, agent.id); }
        catch { throw new A2AHttpError(409, 'Configure a supported runtime, model and exclusive networked Docker sandbox first.'); }
      }
      await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agent.a2a.local.configure',
        targetType: 'Agent', targetId: agent.id, changes: { enabled: input.enabled } });
      return {};
    }
    const endpoint = await tx.agentEndpoint.findFirst({ where: { workspaceId: ctx.workspaceId, sourceAgentId: agent.id }, select: { id: true } });
    if (!endpoint) throw new A2AHttpError(409, 'Publish an isolated Agent service first.');
    await tx.$queryRaw`SELECT id FROM "AgentEndpoint" WHERE id=${endpoint.id} FOR UPDATE`;
    const current = await tx.agentEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    const issuing = input.action === 'create-client' || input.action === 'create-key';
    if ((issuing || (input.action === 'set-public' && input.enabled)) && (current.status !== 'active' || !current.currentRevisionId)) {
      throw new A2AHttpError(409, 'An active published revision is required.');
    }
    if (input.action === 'set-public') {
      await tx.agentEndpoint.update({ where: { id: endpoint.id }, data: { a2aEnabled: input.enabled } });
      await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agent.a2a.configure',
        targetType: 'AgentEndpoint', targetId: endpoint.id, changes: { enabled: input.enabled } });
      return {};
    }
    if (input.action === 'revoke-key') {
      const key = await tx.agentApiKey.findFirst({ where: { id: input.keyId, client: { endpointId: endpoint.id } },
        select: { id: true, revokedAt: true, client: { select: { scopes: true } } } });
      if (!key || !isA2AClient(key.client.scopes)) throw new A2AHttpError(404, 'A2A key unavailable.');
      if (!key.revokedAt) {
        await tx.agentApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
        await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agentApiKey.revoked', targetType: 'agentApiKey', targetId: key.id });
      }
      return {};
    }
    if (!current.a2aEnabled) throw new A2AHttpError(409, 'Enable A2A before creating credentials.');
    let clientId: string;
    if (input.action === 'create-client') {
      if (await tx.agentApiClient.count({ where: { endpointId: endpoint.id } }) >= 100) throw new A2AHttpError(409, 'Client limit reached.');
      const client = await tx.agentApiClient.create({ data: { endpointId: endpoint.id, createdById: ctx.actorId, name: input.name, scopes: [...A2A_SCOPES] } });
      clientId = client.id;
      await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agent.a2a.client.created',
        targetType: 'AgentApiClient', targetId: clientId });
    } else {
      const client = await tx.agentApiClient.findFirst({ where: { id: input.clientId, endpointId: endpoint.id, status: 'active' }, select: { id: true, scopes: true } });
      if (!client || !isA2AClient(client.scopes)) throw new A2AHttpError(404, 'A2A client unavailable.');
      clientId = client.id;
    }
    if (await tx.agentApiKey.count({ where: { clientId } }) >= 50) throw new A2AHttpError(409, 'Key limit reached.');
    // Same established token format/hash as Endpoint auth, atomically with client + audit.
    const token = generateAgentApiKey();
    const key = await tx.agentApiKey.create({ data: { clientId, name: 'A2A service key', tokenHash: hashAgentApiKey(token), prefix: agentApiKeyPrefix(token) } });
    await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agentApiKey.created',
      targetType: 'agentApiKey', targetId: key.id, changes: { clientId } });
    return { token, clientId };
  });
}
