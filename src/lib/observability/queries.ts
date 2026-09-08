import 'server-only';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';

export const logFilterSchema = z.object({
  q: z.string().max(200).optional(),
  domain: z.preprocess((value) => value === 'all' ? undefined : value, z.enum(['http', 'mcp', 'agent', 'runtime', 'channel', 'plugin', 'system']).optional()),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  outcome: z.enum(['success', 'error', 'timeout', 'cancelled', 'denied']).optional(),
  workspaceId: z.string().max(200).optional(), actorId: z.string().max(200).optional(),
  deploymentId: z.string().max(200).optional(), agentId: z.string().max(200).optional(),
  channelId: z.string().max(200).optional(), runId: z.string().max(200).optional(),
  model: z.string().max(200).optional(), traceId: z.string().max(200).optional(),
  requestId: z.string().max(200).optional(), eventName: z.string().max(200).optional(),
  targetType: z.string().max(200).optional(), targetId: z.string().max(200).optional(),
  errorType: z.string().max(200).optional(), errorCode: z.string().max(200).optional(),
  since: z.preprocess(utcInput, z.coerce.date()).default(() => new Date(Date.now() - 86_400_000)),
  until: z.preprocess(utcInput, z.coerce.date()).default(() => new Date()),
  cursor: z.string().max(1000).refine((value) => {
    try { cursorWhere(value); return true; } catch { return false; }
  }, 'Invalid cursor').optional(),
}).refine((v) => v.until >= v.since && v.until.getTime() - v.since.getTime() <= 31 * 86_400_000, 'Maximum window is 31 days');
export type LogFilters = z.infer<typeof logFilterSchema>;
function utcInput(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(value) ? `${value}Z` : value;
}
export type LogScope = { adminId: string } | { userId: string; workspaceId: string };
export class LogAccessError extends Error {}

export async function authorizeLogs(scope: LogScope) {
  const user = await db.user.findUnique({ where: { id: 'adminId' in scope ? scope.adminId : scope.userId }, select: { role: true, status: true } });
  if (!user || user.status !== 'active') throw new LogAccessError('Forbidden');
  if ('adminId' in scope) {
    if (user.role !== 'admin') throw new LogAccessError('Forbidden');
  } else if (!await db.workspace.findFirst({ where: { id: scope.workspaceId,
    status: 'active', OR: [{ ownerId: scope.userId }, { members: { some: { userId: scope.userId } } }],
  }, select: { id: true } })) throw new LogAccessError('Forbidden');
}

export function logWhere(filters: LogFilters): Prisma.LogEventWhereInput {
  const { since, until, q, cursor: _cursor, targetType: _targetType, targetId: _targetId, ...values } = filters;
  void _cursor;
  void _targetType;
  void _targetId;
  return { ...values, createdAt: { gte: since, lte: until }, ...(q ? { OR:
    ['message', 'eventName', 'errorCode', 'toolName', 'requestId', 'traceId'].map((key) => ({ [key]: { contains: q, mode: 'insensitive' } })),
  } : {}) };
}

export function auditWhere(filters: LogFilters): Prisma.AuditEventWhereInput {
  return { createdAt: { gte: filters.since, lte: filters.until }, workspaceId: filters.workspaceId,
    actorId: filters.actorId, traceId: filters.traceId, requestId: filters.requestId,
    targetType: filters.targetType, targetId: filters.targetId,
    ...(filters.q ? { OR: [{ action: { contains: filters.q } }, { targetId: { contains: filters.q } }] } : {}),
  };
}

export const logCursor = (row: { id: string; createdAt: Date }) => Buffer.from(JSON.stringify({ id: row.id, at: row.createdAt.toISOString() })).toString('base64url');
export function cursorWhere(cursor?: string): Prisma.LogEventWhereInput {
  if (!cursor) return {};
  const parsed = z.object({ id: z.string().min(1).max(200), at: z.string().datetime() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  return { OR: [{ createdAt: { lt: new Date(parsed.at) } }, { createdAt: new Date(parsed.at), id: { lt: parsed.id } }] };
}

export async function listLogEvents(scope: LogScope, input: Record<string, unknown>) {
  await authorizeLogs(scope);
  const filters = logFilterSchema.parse(input);
  if ('workspaceId' in scope) filters.workspaceId = scope.workspaceId;
  const rows = await db.logEvent.findMany({ where: { AND: [logWhere(filters), cursorWhere(filters.cursor)] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
  return { rows: rows.slice(0, 50), nextCursor: rows.length > 50 ? logCursor(rows[49]) : null, until: filters.until.toISOString() };
}

export async function getLogEvent(scope: LogScope, id: string) {
  await authorizeLogs(scope);
  return db.logEvent.findFirst({ where: { id, ...('workspaceId' in scope ? { workspaceId: scope.workspaceId } : {}) },
    include: { detail: 'adminId' in scope ? { where: { expiresAt: { gt: new Date() } } } : false } });
}

export async function getLogTrace(scope: LogScope, traceId: string) {
  await authorizeLogs(scope);
  return db.logEvent.findMany({ where: { traceId, ...('workspaceId' in scope ? { workspaceId: scope.workspaceId } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 501 });
}

export function logSqlWhere(filters: LogFilters) {
  const terms = [Prisma.sql`"createdAt" >= ${filters.since}`, Prisma.sql`"createdAt" <= ${filters.until}`];
  for (const key of ['domain', 'level', 'outcome', 'workspaceId', 'actorId', 'deploymentId', 'agentId', 'channelId', 'runId', 'model', 'traceId', 'requestId', 'eventName', 'errorType', 'errorCode'] as const) {
    if (filters[key]) terms.push(Prisma.sql`${Prisma.raw(`"${key}"`)} = ${filters[key]}`);
  }
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    terms.push(Prisma.sql`("message" ILIKE ${pattern} OR "eventName" ILIKE ${pattern} OR "errorCode" ILIKE ${pattern} OR "toolName" ILIKE ${pattern} OR "requestId" ILIKE ${pattern} OR "traceId" ILIKE ${pattern})`);
  }
  return Prisma.join(terms, ' AND ');
}

export type LogStats = { total: number; errors: number; avgMs: number; p95Ms: number };
export async function aggregateLogs(filters: LogFilters): Promise<LogStats> {
  const [stats] = await db.$queryRaw<LogStats[]>(Prisma.sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors,
      coalesce(round(avg("durationMs")), 0)::int AS "avgMs",
      coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY "durationMs"), 0)::int AS "p95Ms"
    FROM "LogEvent" WHERE ${logSqlWhere(filters)}`);
  return stats;
}

export async function getErrorGroups(scope: LogScope, input: Record<string, unknown>) {
  await authorizeLogs(scope);
  const filters = logFilterSchema.parse(input);
  if ('workspaceId' in scope) filters.workspaceId = scope.workspaceId;
  return db.$queryRaw<Array<{ errorType: string | null; errorCode: string | null; eventName: string; outcome: string; count: number; workspaces: number; first: Date; last: Date }>>(Prisma.sql`
    SELECT "errorType", "errorCode", "eventName", outcome, count(*)::int AS count,
      count(DISTINCT "workspaceId")::int AS workspaces, min("createdAt") AS first, max("createdAt") AS last
    FROM "LogEvent" WHERE ${logSqlWhere(filters)} AND outcome IN ('error', 'timeout')
    GROUP BY "errorType", "errorCode", "eventName", outcome ORDER BY count DESC LIMIT 20`);
}
