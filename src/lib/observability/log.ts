import "server-only";
import { Prisma, type LogEvent } from "@prisma/client";
import { db } from "@/lib/db";
import { formatInTimeZone } from "@/lib/timezone";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { inspectMcpLog } from "./mcp-log-entry";
import { recordEvent, type LogOutcome } from "./events";
import { boundedResponseText, type PayloadPolicy } from "./payload";
import { enrichLogContext } from "./context";
import {
  aggregateLogs,
  authorizeLogs,
  cursorWhere,
  logCursor,
  logFilterSchema,
  logSqlWhere,
  logWhere,
} from "./queries";

export async function logRequest(entry: {
  workspaceId: string;
  deploymentId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody?: string | null;
  responseBody?: string | null;
  outcome?: LogOutcome;
  error?: unknown;
  response?: Response;
  payloadPolicy?: PayloadPolicy;
  payload?: () => unknown;
}): Promise<void> {
  enrichLogContext({ workspaceId: entry.workspaceId });
  const policy =
    entry.payloadPolicy ??
    (entry.path.includes("/agents/mcp") ? "agent-content" : "diagnostic");
  const metadataBody =
    entry.responseBody ??
    (!entry.outcome && entry.response
      ? await boundedResponseText(entry.response)
      : null);
  const inspection = inspectMcpLog({ ...entry, responseBody: metadataBody });
  const parse = (text?: string | null) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return "[INVALID OR TRUNCATED JSON]";
    }
  };
  await recordEvent({
    domain: "mcp",
    eventName: "gateway.request",
    workspaceId: entry.workspaceId,
    deploymentId: entry.deploymentId ?? undefined,
    method: entry.method,
    path: entry.path.split("#")[0],
    rpcMethod: inspection.rpcMethod ?? undefined,
    toolName: inspection.toolName ?? undefined,
    httpStatus: entry.statusCode,
    durationMs: entry.durationMs,
    outcome: entry.outcome ?? inspection.outcome,
    message:
      policy === "agent-content"
        ? "Agent Control request"
        : (inspection.errorSummary ??
          inspection.toolName ??
          inspection.rpcMethod ??
          entry.path),
    error: entry.error,
    payloadPolicy: policy,
    detail:
      entry.payload ??
      (async () => ({
        request: parse(entry.requestBody),
        response: parse(
          entry.response
            ? await boundedResponseText(entry.response)
            : entry.responseBody,
        ),
      })),
  });
}

type LogWithDetail = LogEvent & { detail?: { data: Prisma.JsonValue } | null };

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function payloadText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? null;
}

function workspacePayload(log: LogWithDetail) {
  const detail = jsonRecord(log.detail?.data);
  return log.domain === "mcp" &&
    log.deploymentId &&
    !log.agentId &&
    (log.eventName === "gateway.request" || log.eventName === "mcp.rpc") &&
    detail?.workspaceMcpPayload === true
    ? jsonRecord(detail.payload)
    : null;
}

function view(log: LogWithDetail, rpcLog?: LogWithDetail) {
  const { detail, ...event } = log;
  const ownPayload = workspacePayload(log);
  const payload =
    ownPayload && ((rpcLog && workspacePayload(rpcLog)) || ownPayload);
  return {
    ...event,
    method: log.method ?? "MCP",
    path: log.path ?? "",
    statusCode: log.httpStatus ?? 0,
    durationMs: log.durationMs ?? 0,
    requestBody: payloadText(payload?.request),
    responseBody: payloadText(payload?.response),
    errorSummary: log.outcome !== "success" ? log.message : null,
  };
}

function requestKey(log: LogEvent): string {
  return JSON.stringify([
    log.traceId,
    log.deploymentId,
    log.rpcMethod,
    log.toolName,
  ]);
}

export async function getDeploymentLogs(
  workspaceId: string,
  deploymentId: string,
  limit = 100,
  userId?: string,
) {
  if (!userId) throw new Error("An authenticated log reader is required");
  await authorizeLogs({ workspaceId, userId });
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const logs = await db.logEvent.findMany({
    where: {
      workspaceId,
      deploymentId,
      eventName: { in: ["gateway.request", "mcp.rpc"] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: boundedLimit * 2,
    include: {
      detail: {
        where: { expiresAt: { gt: new Date() } },
        select: { data: true },
      },
    },
  });
  const gatewayRequests = new Set(
    logs.filter((log) => log.eventName === "gateway.request").map(requestKey),
  );
  const rpcLogs = new Map(
    logs
      .filter((log) => log.eventName === "mcp.rpc")
      .map((log) => [requestKey(log), log]),
  );
  return logs
    .filter(
      (log) =>
        log.eventName === "gateway.request" ||
        !gatewayRequests.has(requestKey(log)),
    )
    .slice(0, boundedLimit)
    .map((log) => view(log, rpcLogs.get(requestKey(log))));
}

export type HourBucket = {
  timestamp: number;
  hour: string;
  total: number;
  errors: number;
};
export type ObservabilityLog = ReturnType<typeof view> & {
  deploymentName: string;
};
export type DeploymentUsage = {
  id: string | null;
  name: string;
  total: number;
  errors: number;
  avgMs: number;
};

export async function getObservability(
  workspaceId: string,
  timeZone: string,
  hours = 24,
  deploymentId?: string,
  options: {
    userId: string;
    q?: string;
    cursor?: string;
    until?: string;
    outcome?: string;
  } = { userId: "" },
) {
  await authorizeLogs({ workspaceId, userId: options.userId });
  hours = Math.min(744, Math.max(1, Math.floor(hours)));
  const now = options.until ? new Date(options.until) : new Date();
  const filters = logFilterSchema.parse({
    workspaceId,
    deploymentId,
    eventName: "gateway.request",
    q: options.q,
    outcome: options.outcome,
    cursor: options.cursor,
    since: new Date(now.getTime() - hours * 3_600_000),
    until: now,
  });
  const where = logSqlWhere(filters);
  const [stats, logs, deploymentRows, buckets, usage] = await Promise.all([
    aggregateLogs(filters),
    db.logEvent.findMany({
      where: { AND: [await logWhere(filters), cursorWhere(filters.cursor)] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      include: {
        detail: {
          where: { expiresAt: { gt: new Date() } },
          select: { data: true },
        },
      },
    }),
    db.deployment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        serverId: true,
        name: true,
        source: true,
        sourceRef: true,
        server: { select: { name: true } },
      },
    }),
    db.$queryRaw<
      Array<{ bucket: Date; total: number; errors: number }>
    >(Prisma.sql`
      SELECT date_trunc('hour', "createdAt") AS bucket, count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors
      FROM "LogEvent" WHERE ${where} GROUP BY bucket ORDER BY bucket`),
    db.$queryRaw<
      Array<{ id: string | null; total: number; errors: number; avgMs: number }>
    >(Prisma.sql`
      SELECT "deploymentId" AS id, count(*)::int AS total,
      count(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled'))::int AS errors,
      coalesce(round(avg("durationMs")), 0)::int AS "avgMs"
      FROM "LogEvent" WHERE ${where} GROUP BY "deploymentId"`),
  ]);
  const page = logs.slice(0, 50);
  const requests = page
    .filter((log) => workspacePayload(log))
    .map((log) => ({
      traceId: log.traceId,
      deploymentId: log.deploymentId,
      rpcMethod: log.rpcMethod,
      toolName: log.toolName,
    }));
  // Keep gateway pagination/counts intact, but show the real upstream reply when paired.
  const rpcRows = requests.length
    ? await db.logEvent.findMany({
        where: { workspaceId, eventName: "mcp.rpc", OR: requests },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: {
          detail: {
            where: { expiresAt: { gt: new Date() } },
            select: { data: true },
          },
        },
      })
    : [];
  const rpcLogs = new Map(rpcRows.map((log) => [requestKey(log), log]));
  const names = new Map(
    deploymentRows.map((row) => [row.id, deploymentLabel(row).name]),
  );
  const bucketMap = new Map(buckets.map((row) => [row.bucket.getTime(), row]));
  const series = Array.from({ length: hours }, (_, i) => {
    const time =
      Math.floor(now.getTime() / 3_600_000) * 3_600_000 -
      (hours - 1 - i) * 3_600_000;
    const row = bucketMap.get(time);
    return {
      timestamp: time,
      hour: formatInTimeZone(time, timeZone, { hour: "numeric" }, "en-US"),
      total: row?.total ?? 0,
      errors: row?.errors ?? 0,
    };
  });
  const deploymentUsage: DeploymentUsage[] = deploymentRows
    .filter((row) => !deploymentId || row.id === deploymentId)
    .map((row) => {
      const name = names.get(row.id);
      if (name === undefined)
        throw new Error("Deployment label is unavailable.");
      return {
        id: row.id,
        name,
        total: 0,
        errors: 0,
        avgMs: 0,
        ...usage.find((item) => item.id === row.id),
      };
    });
  const api = usage.find((row) => row.id === null);
  if (api) deploymentUsage.push({ ...api, name: "Workspace API" });
  return {
    ...stats,
    series,
    deploymentUsage,
    recent: page.map((row) => ({
      ...view(row, rpcLogs.get(requestKey(row))),
      deploymentName: row.deploymentId
        ? (names.get(row.deploymentId) ?? "Deleted deployment")
        : "Workspace API",
    })),
    nextCursor: logs.length > 50 ? logCursor(logs[49]) : null,
    until: now.toISOString(),
    deployments: deploymentRows.map((row) => {
      const name = names.get(row.id);
      if (name === undefined)
        throw new Error("Deployment label is unavailable.");
      return { id: row.id, name };
    }),
    selectedDeployment: deploymentId
      ? (names.get(deploymentId) ?? "Unknown deployment")
      : null,
  };
}
