import 'server-only';
import { AGENT_API_MAX_INPUT_CHARACTERS, AGENT_API_MAX_OUTPUT_CHARACTERS } from '@/lib/agents/public-api/body';
import { Prisma } from '@prisma/client';
import { JsonRpcTransportError } from '@a2a-js/sdk/errors';
import { isWorkspaceGrant, type TaskGrant } from './principal';
import { A2A_LIMITS } from './model';

export const A2A_TASK_STORAGE_BYTES = 4 * 1024 * 1024;
export const A2A_WORKSPACE_STORAGE = 1_000_000_000;
export const A2A_WORKSPACE_DAILY_OUTPUT = 500_000_000;
export const A2A_QUOTA_ERROR = -32099; // Application-defined JSON-RPC server error, not a new A2A semantic code.
const DAY = 86_400_000;
type Tx = Prisma.TransactionClient;
type Scope = { workspaceId: string; endpointId?: string; clientId?: string };
export class A2AQuotaError extends JsonRpcTransportError {
  constructor() { super({ jsonrpc: '2.0', id: null, error: { code: A2A_QUOTA_ERROR, message: 'Agent resource quota exhausted.' } }); }
}
const isLocal = isWorkspaceGrant;
export const outputBucket = (kind: 'workspace' | 'endpoint' | 'client', id: string) => `a2a-output:${kind}:${id}`;
const dayStart = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);

/** Payload storage accounting, not physical database disk usage. Called in the same task/event transaction. */
export async function refreshTaskStorage(tx: Tx, id: string, permitFailureSettlement = false) {
  const rows = await tx.$queryRaw<Array<{ bytes: bigint | number; sequence: number }>>`
    SELECT octet_length(t.snapshot::text)::bigint + octet_length(t.request::text) + octet_length(t.grant::text)
      + COALESCE((SELECT SUM(octet_length(e.payload::text)) FROM "A2AEvent" e WHERE e."taskId"=t.id), 0)
      + COALESCE(octet_length(t."remoteTaskId"), 0) + COALESCE(octet_length(t."remoteContextId"), 0)
      + COALESCE(octet_length(t."remoteMessageId"), 0)
      + 512 * (SELECT COUNT(*) FROM "A2ARequest" r WHERE r."taskId"=t.id) AS bytes, t.sequence
    FROM "A2ATask" t WHERE t.id=${id}`;
  const row = rows[0];
  if (!row) throw new Error('Task storage record disappeared.');
  // Keep headroom for a final failure/cancellation event, even when a successful output is too large.
  if (!permitFailureSettlement && (Number(row.bytes) > A2A_TASK_STORAGE_BYTES - 16_384 || row.sequence > 128)) throw new A2AQuotaError();
  await tx.a2ATask.update({ where: { id }, data: { storageBytes: Number(row.bytes) } });
}

/** Both Responses admission and native A2A admission hold the workspace lock before reading these charges. */
export async function readNativeQuotaCharges(tx: Tx, scope: Scope, now = new Date()) {
  const scopes = [
    ['workspace', scope.workspaceId, Prisma.sql`c."workspaceId"=${scope.workspaceId}`],
    ['endpoint', scope.endpointId, Prisma.sql`c."endpointId"=${scope.endpointId ?? ''}`],
    ['client', scope.clientId, Prisma.sql`c."clientId"=${scope.clientId ?? ''}`],
  ] as const;
  const result = { workspaceStored: 0, endpointStored: 0, clientStored: 0, workspaceOutput: 0, endpointOutput: 0, clientOutput: 0 };
  for (const [kind, id, where] of scopes) {
    if (!id) continue;
    const [storage] = await tx.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COALESCE(SUM(CASE WHEN t.state IN (1,2,6,8)
        THEN GREATEST(t."storageBytes", ${A2A_TASK_STORAGE_BYTES}) ELSE t."storageBytes" END),0) AS total
      FROM "A2ATask" t JOIN "A2AContext" c ON c.id=t."contextId" WHERE ${where}`;
    const usage = await tx.agentApiUsageBucket.findUnique({ where: { key_windowStart_windowSeconds: {
      key: outputBucket(kind, id), windowStart: dayStart(now), windowSeconds: 86400,
    } } });
    result[`${kind}Stored`] = Number(storage?.total ?? 0);
    result[`${kind}Output`] = usage?.count ?? 0;
  }
  return result;
}

async function serviceLimits(tx: Tx, grant: TaskGrant) {
  if (isLocal(grant)) return null;
  const service = grant;
  const endpoint = await tx.agentEndpoint.findUniqueOrThrow({ where: { id: service.endpointId },
    select: { workspaceId: true, maxStoredCharacters: true, dailyOutputCharacterLimit: true } });
  const client = await tx.agentApiClient.findUniqueOrThrow({ where: { id: service.clientId },
    select: { endpointId: true, maxStoredCharacters: true, dailyOutputCharacterLimit: true } });
  if (endpoint.workspaceId !== grant.workspaceId || client.endpointId !== service.endpointId) throw new Error('Invalid quota scope');
  return { endpoint, client, endpointId: service.endpointId, clientId: service.clientId };
}

async function legacyCharges(tx: Tx, scope: Scope, now: Date) {
  const clauses = [
    ['workspace', Prisma.sql`e."workspaceId"=${scope.workspaceId}`],
    ['endpoint', Prisma.sql`e.id=${scope.endpointId ?? ''}`],
    ['client', Prisma.sql`r."clientId"=${scope.clientId ?? ''}`],
  ] as const;
  const result = { workspaceOutput: 0, endpointOutput: 0, clientOutput: 0, workspaceStored: 0, endpointStored: 0, clientStored: 0 };
  for (const [kind, where] of clauses) {
    if (kind === 'endpoint' && !scope.endpointId || kind === 'client' && !scope.clientId) continue;
    const [usage] = await tx.$queryRaw<Array<{ output: bigint | number; active: bigint | number }>>`
      SELECT COALESCE(SUM(CASE WHEN r."createdAt">=${dayStart(now)} THEN r."outputCharacters" ELSE 0 END),0) AS output,
        COUNT(*) FILTER (WHERE r.status IN ('provisioning','running')) AS active
      FROM "AgentRun" r JOIN "AgentEndpoint" e ON e.id=r."endpointId" WHERE ${where}`;
    const storageWhere = kind === 'workspace' ? Prisma.sql`e."workspaceId"=${scope.workspaceId}`
      : kind === 'endpoint' ? Prisma.sql`e.id=${scope.endpointId!}` : Prisma.sql`p."clientId"=${scope.clientId!}`;
    const [storage] = await tx.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COALESCE(SUM(p."storedCharacters"),0) AS total FROM "AgentPublicConversation" p
      JOIN "AgentEndpoint" e ON e.id=p."endpointId" WHERE ${storageWhere} AND p."deletingAt" IS NULL`;
    // Existing Responses bounds: 200,000 output + 20,000 input characters per active run.
    result[`${kind}Output`] = Number(usage?.output ?? 0) + Number(usage?.active ?? 0) * AGENT_API_MAX_OUTPUT_CHARACTERS;
    result[`${kind}Stored`] = Number(storage?.total ?? 0) + Number(usage?.active ?? 0) * (AGENT_API_MAX_OUTPUT_CHARACTERS + AGENT_API_MAX_INPUT_CHARACTERS);
  }
  return result;
}

/** Reserve retained-space headroom before accepting another task, not after it has consumed a model call. */
export async function assertNativeStorageCapacity(tx: Tx, grant: TaskGrant, newTask: boolean) {
  const service = await serviceLimits(tx, grant);
  const scope = { workspaceId: grant.workspaceId, endpointId: service?.endpointId, clientId: service?.clientId };
  const native = await readNativeQuotaCharges(tx, scope);
  const legacy = await legacyCharges(tx, scope, new Date());
  const extra = newTask ? A2A_TASK_STORAGE_BYTES : 0;
  if (native.workspaceStored + legacy.workspaceStored + extra > A2A_WORKSPACE_STORAGE
    || service && (native.endpointStored + legacy.endpointStored + extra > service.endpoint.maxStoredCharacters
      || native.clientStored + legacy.clientStored + extra > service.client.maxStoredCharacters)) throw new A2AQuotaError();
}

/** Conservative output ceiling reserved per claimed native execution, never reported as actual tokens or billing. */
export async function reserveNativeExecutionOutput(tx: Tx, grant: TaskGrant, deadline: Date, now = new Date()) {
  const service = await serviceLimits(tx, grant);
  const scope = { workspaceId: grant.workspaceId, endpointId: service?.endpointId, clientId: service?.clientId };
  const days = [dayStart(now)];
  const next = new Date(days[0].getTime() + DAY);
  if (deadline > next) days.push(next); // A round spanning midnight cannot move its reservation outside the new day's quota.
  const reservation = A2A_LIMITS.outputCharacters + (isLocal(grant) ? (A2A_LIMITS.artifactsPerTask - 1) * A2A_LIMITS.publishArtifactBytes : 0);
  for (const day of days) {
    const native = await readNativeQuotaCharges(tx, scope, day);
    const legacy = await legacyCharges(tx, scope, day);
    const entries = [
      { kind: 'workspace' as const, id: grant.workspaceId, limit: A2A_WORKSPACE_DAILY_OUTPUT },
      ...(service ? [{ kind: 'endpoint' as const, id: service.endpointId, limit: service.endpoint.dailyOutputCharacterLimit },
        { kind: 'client' as const, id: service.clientId, limit: service.client.dailyOutputCharacterLimit }] : []),
    ];
    for (const { kind, id, limit } of entries) {
      if (native[`${kind}Output`] + legacy[`${kind}Output`] + reservation > limit) throw new A2AQuotaError();
      await tx.agentApiUsageBucket.upsert({ where: { key_windowStart_windowSeconds: { key: outputBucket(kind, id), windowStart: day, windowSeconds: 86400 } },
        create: { key: outputBucket(kind, id), windowStart: day, windowSeconds: 86400, count: reservation, expiresAt: new Date(day.getTime() + DAY * 2) },
        update: { count: { increment: reservation } } });
    }
  }
}
