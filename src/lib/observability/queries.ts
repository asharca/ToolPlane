import "server-only";
import { Prisma } from "@prisma/client";
import type { LogEvent, LogDetail } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { a2aLogMetadataSchema } from "./events";
import type { A2ALogMetadata } from "./events";
import { writeAudit } from "./audit";

export function getA2aMetadata(attributes: unknown): A2ALogMetadata | null {
  if (!attributes || typeof attributes !== "object" || !("data" in attributes))
    return null;
  const data = attributes.data;
  if (!data || typeof data !== "object" || !("a2a" in data)) return null;
  const result = a2aLogMetadataSchema.safeParse(data.a2a);
  return result.success ? result.data : null;
}

const a2aFilterKeys = [
  "direction",
  "endpointId",
  "clientId",
  "taskId",
  "contextId",
  "rootTaskId",
  "parentTaskId",
] as const;
const a2aSearchKeys = [
  "endpointId",
  "clientId",
  "remoteAgentId",
  "taskId",
  "contextId",
  "rootTaskId",
  "parentTaskId",
] as const;
const logColumnKeys = [
  "domain",
  "level",
  "outcome",
  "workspaceId",
  "actorId",
  "deploymentId",
  "agentId",
  "channelId",
  "runId",
  "model",
  "traceId",
  "requestId",
  "eventName",
  "errorType",
  "errorCode",
  "rpcMethod",
] as const;
const logSearchKeys = [
  "message",
  "eventName",
  "errorCode",
  "toolName",
  "requestId",
  "traceId",
  "rpcMethod",
  "path",
] as const;

export const logFilterSchema = z
  .object({
    q: z.string().max(200).optional(),
    domain: z.preprocess(
      (value) => (value === "all" ? undefined : value),
      z
        .enum([
          "http",
          "mcp",
          "a2a",
          "agent",
          "runtime",
          "channel",
          "plugin",
          "system",
        ])
        .optional(),
    ),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    outcome: z
      .enum(["success", "error", "timeout", "cancelled", "denied"])
      .optional(),
    workspaceId: z.string().max(200).optional(),
    actorId: z.string().max(200).optional(),
    deploymentId: z.string().max(200).optional(),
    agentId: z.string().max(200).optional(),
    channelId: z.string().max(200).optional(),
    runId: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    traceId: z.string().max(200).optional(),
    requestId: z.string().max(200).optional(),
    eventName: z.string().max(200).optional(),
    targetType: z.string().max(200).optional(),
    targetId: z.string().max(200).optional(),
    errorType: z.string().max(200).optional(),
    errorCode: z.string().max(200).optional(),
    direction: z.enum(["inbound", "outbound", "internal"]).optional(),
    rpcMethod: z.string().max(200).optional(),
    endpointId: z.string().max(200).optional(),
    clientId: z.string().max(200).optional(),
    taskId: z.string().max(200).optional(),
    contextId: z.string().max(200).optional(),
    rootTaskId: z.string().max(200).optional(),
    parentTaskId: z.string().max(200).optional(),
    since: z
      .preprocess(utcInput, z.coerce.date())
      .default(() => new Date(Date.now() - 86_400_000)),
    until: z.preprocess(utcInput, z.coerce.date()).default(() => new Date()),
    cursor: z
      .string()
      .max(1000)
      .refine((value) => {
        try {
          cursorWhere(value);
          return true;
        } catch {
          return false;
        }
      }, "Invalid cursor")
      .optional(),
  })
  .refine(
    (v) =>
      v.until >= v.since &&
      v.until.getTime() - v.since.getTime() <= 31 * 86_400_000,
    "Maximum window is 31 days",
  );
export type LogFilters = z.infer<typeof logFilterSchema>;

export function resolveLogFilters(input: Record<string, unknown>): LogFilters {
  const values = { ...input };
  if (input.tab === "a2a") {
    values.domain = "a2a";
    if (
      !input.eventName &&
      !["taskId", "contextId", "rootTaskId", "parentTaskId"].some(
        (key) => input[key],
      )
    )
      values.eventName = "a2a.request";
  } else if (
    input.domain === undefined &&
    ["http", "agent", "runtime"].includes(String(input.tab))
  )
    values.domain = input.tab;
  return logFilterSchema.parse(values);
}
function utcInput(value: unknown) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(value)
    ? `${value}Z`
    : value;
}
export type LogScope =
  | { adminId: string }
  | { userId: string; workspaceId: string };
export class LogAccessError extends Error {}

export async function authorizeLogs(scope: LogScope) {
  const user = await db.user.findUnique({
    where: { id: "adminId" in scope ? scope.adminId : scope.userId },
    select: { role: true, status: true },
  });
  if (user?.status !== "active") throw new LogAccessError("Forbidden");
  if ("adminId" in scope) {
    if (user.role !== "admin") throw new LogAccessError("Forbidden");
  } else if (
    !(await db.workspace.findFirst({
      where: {
        id: scope.workspaceId,
        status: "active",
        OR: [
          { ownerId: scope.userId },
          { members: { some: { userId: scope.userId } } },
        ],
      },
      select: { id: true },
    }))
  )
    throw new LogAccessError("Forbidden");
}

export async function logWhere(
  filters: LogFilters,
): Promise<Prisma.LogEventWhereInput> {
  const values = Object.fromEntries(
    logColumnKeys
      .filter((key) => key !== "agentId" && filters[key] !== undefined)
      .map((key) => [key, filters[key]]),
  );
  const conditions: Prisma.LogEventWhereInput[] = a2aFilterKeys
    .filter((key) => filters[key] !== undefined)
    .map((key) => ({
      attributes: { path: ["data", "a2a", key], equals: filters[key] },
    }));
  if (filters.agentId) {
    const endpoints = await db.agentEndpoint.findMany({
      where: {
        sourceAgentId: filters.agentId,
        workspaceId: filters.workspaceId,
      },
      select: { id: true, workspaceId: true },
    });
    conditions.push({
      OR: [
        { agentId: filters.agentId },
        ...endpoints.map((endpoint) => ({
          domain: "a2a",
          workspaceId: endpoint.workspaceId,
          attributes: {
            path: ["data", "a2a", "endpointId"],
            equals: endpoint.id,
          },
        })),
      ],
    });
  }
  return {
    ...values,
    createdAt: { gte: filters.since, lte: filters.until },
    ...(conditions.length ? { AND: conditions } : {}),
    ...(filters.q
      ? {
          OR: [
            ...logSearchKeys.map((key) => ({
              [key]: { contains: filters.q, mode: "insensitive" },
            })),
            ...a2aSearchKeys.map((key) => ({
              attributes: {
                path: ["data", "a2a", key],
                string_contains: filters.q,
                mode: "insensitive" as const,
              },
            })),
          ],
        }
      : {}),
  };
}

export function auditWhere(filters: LogFilters): Prisma.AuditEventWhereInput {
  return {
    createdAt: { gte: filters.since, lte: filters.until },
    workspaceId: filters.workspaceId,
    actorId: filters.actorId,
    traceId: filters.traceId,
    requestId: filters.requestId,
    targetType: filters.targetType,
    targetId: filters.targetId,
    ...(filters.q
      ? {
          OR: [
            { action: { contains: filters.q } },
            { targetId: { contains: filters.q } },
          ],
        }
      : {}),
  };
}

export const logCursor = (row: { id: string; createdAt: Date }) =>
  Buffer.from(
    JSON.stringify({ id: row.id, at: row.createdAt.toISOString() }),
  ).toString("base64url");
export function cursorWhere(cursor?: string): Prisma.LogEventWhereInput {
  if (!cursor) return {};
  const parsed = z
    .object({ id: z.string().min(1).max(200), at: z.string().datetime() })
    .parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  return {
    OR: [
      { createdAt: { lt: new Date(parsed.at) } },
      { createdAt: new Date(parsed.at), id: { lt: parsed.id } },
    ],
  };
}

function workspaceA2aEvent(
  row: Pick<
    LogEvent,
    "domain" | "eventName" | "outcome" | "attributes" | "agentId"
  >,
): boolean {
  const a2a = getA2aMetadata(row.attributes);
  return (
    row.domain === "a2a" &&
    ["a2a.request", "a2a.task.settled"].includes(row.eventName) &&
    row.outcome !== "denied" &&
    !!a2a &&
    !!(row.agentId || a2a.endpointId)
  );
}

export type LogDetailState =
  | "available"
  | "truncated"
  | "expired"
  | "unavailable"
  | "restricted";
function detailState(
  scope: LogScope,
  detail: { expiresAt: Date; truncated: boolean } | null,
  workspaceReadable = false,
): LogDetailState {
  if (!detail) return "unavailable";
  if (detail.expiresAt.getTime() <= Date.now()) return "expired";
  if ("workspaceId" in scope && !workspaceReadable) return "restricted";
  return detail.truncated ? "truncated" : "available";
}

export async function listLogEvents(
  scope: LogScope,
  input: Record<string, unknown>,
) {
  await authorizeLogs(scope);
  const filters = resolveLogFilters(input);
  if ("workspaceId" in scope) filters.workspaceId = scope.workspaceId;
  const rows = await db.logEvent.findMany({
    where: { AND: [await logWhere(filters), cursorWhere(filters.cursor)] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 51,
    include: { detail: { select: { expiresAt: true, truncated: true } } },
  });
  return {
    rows: rows.slice(0, 50).map(({ detail, ...row }) => ({
      ...row,
      detailState: detailState(scope, detail, workspaceA2aEvent(row)),
    })),
    nextCursor: rows.length > 50 ? logCursor(rows[49]) : null,
    until: filters.until.toISOString(),
  };
}

export async function getLogEvent(
  scope: LogScope,
  id: string,
): Promise<
  (LogEvent & { detailState: LogDetailState; detail?: LogDetail | null }) | null
> {
  await authorizeLogs(scope);
  const row = await db.logEvent.findFirst({
    where: {
      id,
      ...("workspaceId" in scope ? { workspaceId: scope.workspaceId } : {}),
    },
    include: { detail: { select: { expiresAt: true, truncated: true } } },
  });
  if (!row) return null;
  const { detail: summary, ...metadata } = row;
  const workspaceReadable = workspaceA2aEvent(row);
  const state = detailState(scope, summary, workspaceReadable);
  if ("workspaceId" in scope && !workspaceReadable)
    return { ...metadata, detailState: state };
  if (state !== "available" && state !== "truncated")
    return { ...metadata, detailState: state, detail: null };
  const detail = await db.logDetail.findUnique({ where: { eventId: id } });
  const beforeAudit = detailState(scope, detail, workspaceReadable);
  if (!detail || beforeAudit === "expired")
    return { ...metadata, detailState: beforeAudit, detail: null };
  // Workspace readers receive only the sanitized protocol envelope, never diagnostic data.
  if ("workspaceId" in scope) {
    const data = detail.data;
    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? data.payload
        : null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { ...metadata, detailState: "unavailable", detail: null };
    detail.data = {
      payload: Object.fromEntries(
        Object.entries(payload).filter(([key]) =>
          ["request", "response", "responseKind", "responseComplete"].includes(
            key,
          ),
        ),
      ),
    };
  }
  await writeAudit(db, {
    actorId: "adminId" in scope ? scope.adminId : scope.userId,
    workspaceId: row.workspaceId ?? undefined,
    action: "logging.detail.viewed",
    targetType: "logEvent",
    targetId: id,
  });
  const afterAudit = detailState(scope, detail, workspaceReadable);
  return {
    ...metadata,
    detailState: afterAudit,
    detail: afterAudit === "expired" ? null : detail,
  };
}

export async function getLogTrace(scope: LogScope, traceId: string) {
  await authorizeLogs(scope);
  return db.logEvent.findMany({
    where: {
      traceId,
      ...("workspaceId" in scope ? { workspaceId: scope.workspaceId } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 501,
  });
}

export function logSqlWhere(filters: LogFilters) {
  const terms = [
    Prisma.sql`"createdAt" >= ${filters.since}`,
    Prisma.sql`"createdAt" <= ${filters.until}`,
  ];
  for (const key of logColumnKeys) {
    if (key !== "agentId" && filters[key] !== undefined)
      terms.push(Prisma.sql`${Prisma.raw(`"${key}"`)} = ${filters[key]}`);
  }
  if (filters.agentId)
    terms.push(Prisma.sql`("agentId" = ${filters.agentId} OR (domain = 'a2a' AND EXISTS (
    SELECT 1 FROM "AgentEndpoint" endpoint WHERE endpoint."sourceAgentId" = ${filters.agentId}
    AND endpoint."workspaceId" = "LogEvent"."workspaceId" AND endpoint.id = attributes->'data'->'a2a'->>'endpointId'
  )))`);
  for (const key of a2aFilterKeys) {
    if (filters[key] !== undefined)
      terms.push(
        Prisma.sql`attributes->'data'->'a2a'->>${key} = ${filters[key]}`,
      );
  }
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    const search = [
      ...logSearchKeys.map(
        (key) => Prisma.sql`${Prisma.raw(`"${key}"`)} ILIKE ${pattern}`,
      ),
      ...a2aSearchKeys.map(
        (key) =>
          Prisma.sql`attributes->'data'->'a2a'->>${key} ILIKE ${pattern}`,
      ),
    ];
    terms.push(Prisma.sql`(${Prisma.join(search, " OR ")})`);
  }
  return Prisma.join(terms, " AND ");
}

export type LogStats = {
  total: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
};
export async function aggregateLogs(filters: LogFilters): Promise<LogStats> {
  const [stats] = await db.$queryRaw<LogStats[]>(Prisma.sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors,
      coalesce(round(avg("durationMs")), 0)::int AS "avgMs",
      coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY "durationMs"), 0)::int AS "p95Ms"
    FROM "LogEvent" WHERE ${logSqlWhere(filters)}`);
  return stats;
}

export async function getErrorGroups(
  scope: LogScope,
  input: Record<string, unknown>,
) {
  await authorizeLogs(scope);
  const filters = resolveLogFilters(input);
  if ("workspaceId" in scope) filters.workspaceId = scope.workspaceId;
  return db.$queryRaw<
    Array<{
      errorType: string | null;
      errorCode: string | null;
      eventName: string;
      outcome: string;
      count: number;
      workspaces: number;
      first: Date;
      last: Date;
    }>
  >(Prisma.sql`
    SELECT "errorType", "errorCode", "eventName", outcome, count(*)::int AS count,
      count(DISTINCT "workspaceId")::int AS workspaces, min("createdAt") AS first, max("createdAt") AS last
    FROM "LogEvent" WHERE ${logSqlWhere(filters)} AND outcome IN ('error', 'timeout')
    GROUP BY "errorType", "errorCode", "eventName", outcome ORDER BY count DESC LIMIT 20`);
}
