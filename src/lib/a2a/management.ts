import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveAgentControlRequestUser } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { parseJson } from '@/lib/agents/public-api/body';
import { createAgentApiKey } from '@/lib/agents/public-api/auth';
import { writeAudit } from '@/lib/observability/audit';
import { withLogContext } from '@/lib/observability/context';
import { A2A_SCOPES } from './principal';

const Input = z.object({ enabled: z.boolean(), clientName: z.string().trim().min(1).max(100).optional() }).strict();
const reply = (body: unknown, status = 200) => Response.json(body, { status,
  headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
/** Explicit owner/admin opt-in. Service credentials never authorize their own publication. */
export async function manageA2AService(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    const user = await resolveAgentControlRequestUser(req);
    if (!user) return reply({ error: 'An account-level Bearer credential is required.' }, 401);
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (!workspace || workspace.status !== 'active') return reply({ error: 'Workspace not found.' }, 404);
    const isAdmin = workspace.ownerId === user.id || Boolean(await db.membership.count({ where: {
      workspaceId: workspace.id, userId: user.id, role: 'admin',
    } }));
    if (!isAdmin) return reply({ error: 'Workspace owner or administrator required.' }, 403);
    if (req.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/json') return reply({ error: 'Content-Type must be application/json.' }, 415);
    const parsed = await parseJson(req, Input, 4096);
    if (!parsed.ok) return reply({ error: 'Invalid A2A publication request.' }, parsed.reason === 'too_large' ? 413 : 400);
    const endpoint = await db.agentEndpoint.findFirst({ where: { workspaceId: workspace.id, sourceAgentId: agentId },
      select: { id: true, publicId: true, status: true, currentRevisionId: true } });
    if (!endpoint || (parsed.value.enabled && (endpoint.status !== 'active' || !endpoint.currentRevisionId))) return reply({ error: 'Publish an active isolated Agent service first.' }, 409);
    try {
      const client = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AgentEndpoint" WHERE id=${endpoint.id} FOR UPDATE`;
        const current = await tx.agentEndpoint.findFirst({ where: { id: endpoint.id, workspaceId: workspace.id,
          ...(parsed.value.enabled ? { status: 'active', currentRevisionId: { not: null } } : {}) } });
        if (!current) throw new Error('Publication changed');
        if (parsed.value.clientName && await tx.agentApiClient.count({ where: { endpointId: endpoint.id } }) >= 100) throw new Error('Client limit');
        await tx.agentEndpoint.update({ where: { id: endpoint.id }, data: { a2aEnabled: parsed.value.enabled } });
        const created = parsed.value.enabled && parsed.value.clientName ? await tx.agentApiClient.create({ data: {
          endpointId: endpoint.id, createdById: user.id, name: parsed.value.clientName, scopes: [...A2A_SCOPES],
        } }) : null;
        await writeAudit(tx, { actorId: user.id, workspaceId: workspace.id, action: 'agent.a2a.configure',
          targetType: 'AgentEndpoint', targetId: endpoint.id,
          changes: { enabled: parsed.value.enabled, clientId: created?.id ?? null } });
        return created;
      });
      // Plaintext is returned once by the established credential service, never in audit data.
      const key = client ? await createAgentApiKey({ actorId: user.id, clientId: client.id,
        endpointPublicId: endpoint.publicId, workspaceId: workspace.id, sourceAgentId: agentId, name: 'A2A service key' }) : null;
      return reply({ enabled: parsed.value.enabled, endpointId: endpoint.publicId,
        rpcPath: `/api/v1/agent-endpoints/${endpoint.publicId}/a2a`,
        agentCardPath: `/api/v1/agent-endpoints/${endpoint.publicId}/a2a/.well-known/agent-card.json`,
        ...(client && key ? { clientId: client.id, token: key.token, scopes: [...A2A_SCOPES] } : {}) });
    } catch { return reply({ error: 'A2A configuration could not be completed. Check the service and client list before retrying.' }, 409); }
  });
}
