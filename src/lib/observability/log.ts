import 'server-only';
import { Prisma, type LogEvent } from '@prisma/client';
import { db } from '@/lib/db';
import { formatInTimeZone } from '@/lib/timezone';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { inspectMcpLog } from './mcp-log-entry';
import { recordEvent, type LogOutcome } from './events';
import { enrichLogContext } from './context';
import { aggregateLogs, authorizeLogs, cursorWhere, logCursor, logFilterSchema, logSqlWhere, logWhere } from './queries';

export async function logRequest(entry: {
  workspaceId: string; deploymentId?: string | null;
  method: string; path: string; statusCode: number; durationMs: number;
  requestBody?: string | null; responseBody?: string | null;
  outcome?: LogOutcome; error?: unknown;
}): Promise<void> {
  enrichLogContext({ workspaceId: entry.workspaceId });
  const inspection = inspectMcpLog(entry);
  const parse = (text?: string | null) => { try { return text ? JSON.parse(text) : null; } catch { return '[INVALID OR TRUNCATED JSON]'; } };
  await recordEvent({
    domain: 'mcp', eventName: 'gateway.request', workspaceId: entry.workspaceId,
    deploymentId: entry.deploymentId ?? undefined, method: entry.method,
    path: entry.path.split('#')[0], rpcMethod: inspection.rpcMethod ?? undefined, toolName: inspection.toolName ?? undefined,
    httpStatus: entry.statusCode, durationMs: entry.durationMs,
    outcome: entry.outcome ?? inspection.outcome,
    message: inspection.errorSummary ?? inspection.toolName ?? inspection.rpcMethod ?? entry.path,
    error: entry.error,
    detail: { request: parse(entry.requestBody), response: parse(entry.responseBody) },
  });
}

function view(log: LogEvent) {
  return { ...log, method: log.method ?? '', path: log.path ?? '', statusCode: log.httpStatus ?? 0,
    durationMs: log.durationMs ?? 0, requestBody: null, responseBody: null,
    errorSummary: log.outcome !== 'success' ? log.message : null };
}

export async function getDeploymentLogs(workspaceId: string, deploymentId: string, limit = 100, userId?: string) {
  if (!userId) throw new Error('An authenticated log reader is required');
  await authorizeLogs({ workspaceId, userId });
  const logs = await db.logEvent.findMany({ where: { workspaceId, deploymentId, eventName: 'gateway.request' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(100, Math.max(1, limit)) });
  return logs.map(view);
}

export type HourBucket = { hour: string; total: number; errors: number };
export type ObservabilityLog = ReturnType<typeof view> & { deploymentName: string };
export type DeploymentUsage = { id: string | null; name: string; total: number; errors: number; avgMs: number };

export async function getObservability(workspaceId: string, timeZone: string, hours = 24, deploymentId?: string,
  options: { userId: string; q?: string; cursor?: string; until?: string; outcome?: string } = { userId: '' }) {
  await authorizeLogs({ workspaceId, userId: options.userId });
  hours = Math.min(744, Math.max(1, Math.floor(hours)));
  const now = options.until ? new Date(options.until) : new Date();
  const filters = logFilterSchema.parse({ workspaceId, deploymentId, eventName: 'gateway.request', q: options.q,
    outcome: options.outcome, cursor: options.cursor, since: new Date(now.getTime() - hours * 3_600_000), until: now });
  const where = logSqlWhere(filters);
  const [stats, logs, deploymentRows, buckets, usage] = await Promise.all([
    aggregateLogs(filters),
    db.logEvent.findMany({ where: { AND: [logWhere(filters), cursorWhere(filters.cursor)] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 }),
    db.deployment.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: { id: true, serverId: true, name: true, source: true, sourceRef: true, server: { select: { name: true } } } }),
    db.$queryRaw<Array<{ bucket: Date; total: number; errors: number }>>(Prisma.sql`
      SELECT date_trunc('hour', "createdAt") AS bucket, count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors
      FROM "LogEvent" WHERE ${where} GROUP BY bucket ORDER BY bucket`),
    db.$queryRaw<Array<{ id: string | null; total: number; errors: number; avgMs: number }>>(Prisma.sql`
      SELECT "deploymentId" AS id, count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors,
      coalesce(round(avg("durationMs")), 0)::int AS "avgMs"
      FROM "LogEvent" WHERE ${where} GROUP BY "deploymentId"`),
  ]);
  const names = new Map(deploymentRows.map((row) => [row.id, deploymentLabel(row).name]));
  const bucketMap = new Map(buckets.map((row) => [row.bucket.getTime(), row]));
  const series = Array.from({ length: hours }, (_, i) => {
    const time = Math.floor(now.getTime() / 3_600_000) * 3_600_000 - (hours - 1 - i) * 3_600_000;
    const row = bucketMap.get(time);
    return { hour: formatInTimeZone(time, timeZone, { hour: 'numeric' }, 'en-US'), total: row?.total ?? 0, errors: row?.errors ?? 0 };
  });
  const deploymentUsage: DeploymentUsage[] = deploymentRows.filter((row) => !deploymentId || row.id === deploymentId).map((row) => ({
    id: row.id, name: names.get(row.id)!, total: 0, errors: 0, avgMs: 0, ...usage.find((item) => item.id === row.id),
  }));
  const api = usage.find((row) => row.id === null);
  if (api) deploymentUsage.push({ ...api, name: 'Workspace API' });
  return { ...stats, series, deploymentUsage,
    recent: logs.slice(0, 50).map((row) => ({ ...view(row), deploymentName: row.deploymentId ? names.get(row.deploymentId) ?? 'Deleted deployment' : 'Workspace API' })),
    nextCursor: logs.length > 50 ? logCursor(logs[49]) : null, until: now.toISOString(),
    deployments: deploymentRows.map((row) => ({ id: row.id, name: names.get(row.id)! })),
    selectedDeployment: deploymentId ? names.get(deploymentId) ?? 'Unknown deployment' : null,
  };
}
