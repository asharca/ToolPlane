import 'server-only';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { db } from '@/lib/db';
import { resolveAgentApiPrincipal, AGENT_CLIENT_TOKEN_PREFIX, hasAgentApiScope } from '@/lib/agents/public-api/auth';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';

export const A2A_SCOPES = ['a2a:send', 'a2a:read', 'a2a:cancel'] as const;
export type A2AOperation = 'send' | 'read' | 'cancel';
/** An authenticated service identity, never caller-supplied A2A metadata. */
export type A2AGrant = {
  workspaceId: string; endpointId: string; endpointPublicId: string; revisionId: string;
  clientId: string; keyId: string | null; ownerKey: string; expiresAt: number | null;
  scopes: string[]; maxConcurrent: number; timeoutSeconds: number; retentionDays: number;
};
export type LocalA2AGrant = {
  kind: 'local'; workspaceId: string; agentId: string; actorId: string;
  targetBinding: string; ownerKey: string; expiresAt: number;
  scopes: string[]; maxConcurrent: number; timeoutSeconds: number; retentionDays: number;
  ancestorTaskIds: string[]; ancestorAgentIds: string[];
  parentTaskId?: string; rootTaskId?: string;
};
export type TaskGrant = A2AGrant | LocalA2AGrant;
export function isLocalGrant(grant: TaskGrant): grant is LocalA2AGrant {
  return 'kind' in grant && grant.kind === 'local';
}
export class A2AHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function permits(grant: Pick<TaskGrant, 'scopes'>, operation: A2AOperation) {
  const required = operation === 'cancel' ? ['a2a:cancel', 'a2a:read'] : [`a2a:${operation}`];
  return hasAgentApiScope(grant.scopes, required);
}
export async function resolveA2AGrant(req: Request, endpointPublicId: string) {
  // Direct server-to-server profile. Browser support needs a separate CORS/OAuth design.
  if (req.headers.has('origin')) throw new A2AHttpError(403, 'Browser origins are not supported by this A2A interface.');
  const principal = await resolveAgentApiPrincipal(req, endpointPublicId);
  if (!principal) throw new A2AHttpError(401, 'A valid Agent Endpoint credential is required.');
  if (!A2A_SCOPES.some((scope) => hasAgentApiScope(principal.scopes, scope))) throw new A2AHttpError(403, 'A2A permission is required.');
  const endpoint = await db.agentEndpoint.findFirst({ where: { id: principal.endpointId,
    a2aEnabled: true, status: 'active', workspace: { status: 'active' } }, select: { id: true } });
  if (!endpoint) throw new A2AHttpError(404, 'Agent service not found.');
  const rate = await takeAgentApiPrincipalRateLimit(principal);
  let expiresAt: number | null = null;
  if (principal.credentialType === 'client_token') {
    // Only after resolveAgentApiPrincipal has verified signature, audience and origin.
    const token = req.headers.get('authorization')!.replace(/^Bearer /i, '').slice(AGENT_CLIENT_TOKEN_PREFIX.length);
    const exp = decodeJwt(token).exp;
    if (!exp) throw new A2AHttpError(401, 'The credential has no expiry.');
    expiresAt = exp * 1000;
  }
  const ownerKey = createHash('sha256').update(JSON.stringify([
    'a2a-v1', principal.endpointId, principal.clientId, principal.subjectHash ?? 'service-client',
  ])).digest('hex');
  const grant: A2AGrant = { workspaceId: principal.workspaceId, endpointId: principal.endpointId,
    endpointPublicId, revisionId: principal.revisionId, clientId: principal.clientId,
    keyId: principal.keyId, ownerKey, expiresAt, scopes: principal.scopes,
    maxConcurrent: principal.limits.maxConcurrent, timeoutSeconds: principal.limits.timeoutSeconds,
    retentionDays: principal.limits.retentionDays };
  return { grant, rateHeaders: rate.headers };
}
/** Rechecked during execution and subscriptions, so revocation is not admission-only. */
export async function assertLiveGrant(grant: TaskGrant, operation: A2AOperation = 'read') {
  if (!permits(grant, operation) || (grant.expiresAt !== null && grant.expiresAt <= Date.now())) throw new TaskNotFoundError();
  if (isLocalGrant(grant)) {
    const { assertLocalGrant } = await import('./local-policy');
    return assertLocalGrant(grant);
  }
  const client = await db.agentApiClient.findFirst({ where: { id: grant.clientId, endpointId: grant.endpointId,
    status: 'active', endpoint: { workspaceId: grant.workspaceId, a2aEnabled: true, status: 'active', currentRevisionId: { not: null },
      workspace: { status: 'active', owner: { status: 'active' } } } }, select: { scopes: true } });
  if (!client || !permits({ ...grant, scopes: client.scopes }, operation)) throw new TaskNotFoundError();
  if (grant.keyId && !await db.agentApiKey.count({ where: { id: grant.keyId, clientId: grant.clientId,
    revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } })) throw new TaskNotFoundError();
}
