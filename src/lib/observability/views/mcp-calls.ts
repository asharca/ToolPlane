import "server-only";
import { Prisma, type LogEvent } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  authorizeLogs,
  getLogEvent,
  logCursor,
  logFilterSchema,
} from "../queries";
import { resolveNames } from "./names";
import type {
  BodyState,
  JsonValue,
  McpCallDetail,
  McpCallFilter,
  McpCallSummary,
  ViewPage,
  ViewScope,
  ViewStats,
} from "./types";

type CallRow = LogEvent & {
  callId: string | null;
  tokenId: string | null;
  callMethod: string | null;
  callTool: string | null;
};
type StreamCursor = { createdAt: string; id: string };
const streamCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().max(200),
});
const callFilterSchema = z.object({
  range: z.enum(["1h", "24h", "7d", "30d", "custom"]).optional(),
  tool: z.string().max(200).optional(),
  callerKind: z.enum(["user", "agent", "token"]).optional(),
  outcome: z.enum(["success", "error"]).optional(),
  slow: z.boolean().optional(),
  slowMs: z.number().finite().nonnegative().default(2000),
});

function criteria(scope: ViewScope, input: McpCallFilter, until?: string) {
  const specific = callFilterSchema.parse(input);
  if (specific.range === "custom" && (!input.since || !input.until))
    throw new Error("Custom time ranges require since and until");
  const end = until ?? input.until ?? new Date().toISOString();
  const hours = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, custom: 24 }[
    specific.range ?? "24h"
  ];
  const filters = logFilterSchema.parse({
    workspaceId:
      scope.kind === "workspace"
        ? scope.workspaceId
        : (scope.workspaceId ?? input.workspaceId),
    deploymentId: input.deploymentId,
    rpcMethod: input.method,
    q: input.q,
    since:
      input.since ??
      new Date(new Date(end).getTime() - hours * 3_600_000).toISOString(),
    until: end,
  });
  const terms = [
    Prisma.sql`e."createdAt" >= ${filters.since}`,
    Prisma.sql`e."createdAt" <= ${filters.until}`,
  ];
  if (filters.deploymentId)
    terms.push(Prisma.sql`e."deploymentId" = ${filters.deploymentId}`);
  if (filters.rpcMethod)
    terms.push(Prisma.sql`e."callMethod" = ${filters.rpcMethod}`);
  if (specific.tool) terms.push(Prisma.sql`e."callTool" = ${specific.tool}`);
  if (specific.callerKind)
    terms.push(
      Prisma.sql`(CASE WHEN e."agentId" IS NOT NULL THEN 'agent' WHEN e."tokenId" IS NOT NULL THEN 'token' WHEN e."actorId" IS NOT NULL THEN 'user' ELSE 'unknown' END) = ${specific.callerKind}`,
    );
  if (specific.outcome === "success")
    terms.push(Prisma.sql`e.outcome IN ('success', 'cancelled')`);
  if (specific.outcome === "error")
    terms.push(Prisma.sql`e.outcome NOT IN ('success', 'cancelled')`);
  if (specific.slow)
    terms.push(Prisma.sql`e."durationMs" >= ${specific.slowMs}`);
  if (filters.q) {
    const pattern = `%${filters.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    terms.push(Prisma.sql`(
      e.id ILIKE ${pattern} OR e."callId" ILIKE ${pattern} OR e.message ILIKE ${pattern}
      OR e."callMethod" ILIKE ${pattern} OR e."callTool" ILIKE ${pattern}
      OR e."traceId" ILIKE ${pattern} OR e."requestId" ILIKE ${pattern}
      OR e."deploymentId" ILIKE ${pattern} OR e."actorId" ILIKE ${pattern}
      OR e."agentId" ILIKE ${pattern} OR e."tokenId" ILIKE ${pattern}
      OR e.path ILIKE ${pattern} OR w.name ILIKE ${pattern}
      OR d.name ILIKE ${pattern} OR d."sourceRef" ILIKE ${pattern} OR s.name ILIKE ${pattern}
      OR a.name ILIKE ${pattern} OR u.name ILIKE ${pattern} OR u.email ILIKE ${pattern}
      OR t.name ILIKE ${pattern}
    )`);
  }
  return {
    workspaceId: filters.workspaceId,
    where: Prisma.join(terms, " AND "),
    slowMs: specific.slowMs,
  };
}

/** Canonicalize before filtering: an upstream record must not reappear when its gateway is filtered out. */
function canonicalCalls(
  workspaceId?: string,
  source: McpCallFilter["source"] = "calls",
) {
  const workspace = workspaceId
    ? Prisma.sql`AND e."workspaceId" = ${workspaceId}`
    : Prisma.empty;
  // Platform plumbing and Agent tool calls have no gateway peer; each is listed on its own tab.
  if (source !== "calls")
    return Prisma.sql`WITH canonical AS (
      SELECT e.*,
        COALESCE(e.attributes->'data'->>'tokenId', e.attributes->'data'->>'apiTokenId') AS "tokenId",
        e."rpcMethod" AS "callMethod", e."toolName" AS "callTool"
      FROM "LogEvent" e
      WHERE ${source === "tools" ? Prisma.sql`e.domain = 'agent' AND e."eventName" = 'sandbox.tool'` : Prisma.sql`e.domain = 'mcp' AND e."eventName" = 'mcp.internal'`} ${workspace}
    )`;
  return Prisma.sql`WITH canonical AS (
    SELECT e.*,
      COALESCE(e.attributes->'data'->>'tokenId', e.attributes->'data'->>'apiTokenId') AS "tokenId",
      COALESCE(e."rpcMethod", NULLIF(split_part(split_part(e.path, '#', 2), ':', 1), '')) AS "callMethod",
      COALESCE(e."toolName", NULLIF(split_part(split_part(e.path, '#', 2), ':', 2), '')) AS "callTool"
    FROM "LogEvent" e
    WHERE e.domain = 'mcp' AND e."eventName" IN ('gateway.request', 'mcp.rpc') ${workspace}
      AND NOT EXISTS (
        SELECT 1 FROM "LogEvent" peer
        WHERE peer.domain = 'mcp' AND peer."workspaceId" IS NOT DISTINCT FROM e."workspaceId"
          AND (
            (e."callId" IS NOT NULL AND peer."callId" = e."callId"
              AND peer."eventName" IN ('gateway.request', 'mcp.rpc')
              AND (
                (peer."eventName" = 'gateway.request' AND e."eventName" = 'mcp.rpc')
                OR (peer."eventName" = e."eventName" AND (peer."createdAt", peer.id) > (e."createdAt", e.id))
              ))
            OR (e."callId" IS NULL AND peer."callId" IS NULL AND e."eventName" = 'mcp.rpc'
              AND peer."eventName" = 'gateway.request' AND peer."traceId" = e."traceId"
              AND peer."deploymentId" IS NOT DISTINCT FROM e."deploymentId"
              AND peer."rpcMethod" IS NOT DISTINCT FROM e."rpcMethod"
              AND peer."toolName" IS NOT DISTINCT FROM e."toolName")
          )
      )
  )`;
}

// Keep name-search joins scoped identically to the batched display-name resolver.
const searchableCalls = Prisma.sql`FROM canonical e
  LEFT JOIN "Workspace" w ON w.id = e."workspaceId"
  LEFT JOIN "Deployment" d ON d.id = e."deploymentId" AND d."workspaceId" = e."workspaceId"
  LEFT JOIN "Server" s ON s.id = d."serverId"
  LEFT JOIN "Agent" a ON a.id = e."agentId" AND a."workspaceId" = e."workspaceId"
  LEFT JOIN "User" u ON u.id = e."actorId" AND (
    w."ownerId" = u.id OR EXISTS (SELECT 1 FROM "Membership" m WHERE m."workspaceId" = e."workspaceId" AND m."userId" = u.id)
  )
  LEFT JOIN "ApiToken" t ON t.id = e."tokenId" AND (
    EXISTS (SELECT 1 FROM "Toolkit" tk WHERE tk.id = t."toolkitId" AND tk."workspaceId" = e."workspaceId")
    OR (t."toolkitId" IS NULL AND (w."ownerId" = t."userId" OR EXISTS (
      SELECT 1 FROM "Membership" m WHERE m."workspaceId" = e."workspaceId" AND m."userId" = t."userId"
    )))
  )`;

async function summaries(rows: CallRow[]): Promise<McpCallSummary[]> {
  const names = await resolveNames(rows);
  return rows.map((row) => ({
    id: row.callId ?? row.id,
    callId: row.callId,
    eventId: row.id,
    createdAt: row.createdAt.toISOString(),
    workspace: names.entity("workspace", row.workspaceId, row.workspaceId),
    deployment: names.entity("deployment", row.deploymentId, row.workspaceId),
    server: names.server(row.deploymentId, row.workspaceId),
    caller: row.agentId
      ? names.party("agent", row.agentId, row.workspaceId)
      : row.tokenId
        ? names.party("token", row.tokenId, row.workspaceId)
        : row.actorId
          ? names.party("user", row.actorId, row.workspaceId)
          : { kind: "unknown", id: null, name: null },
    method: row.callMethod,
    tool: row.callTool,
    outcome:
      row.outcome === "success" || row.outcome === "cancelled"
        ? "success"
        : "error",
    durationMs: row.durationMs,
    httpStatus: row.httpStatus,
    error:
      row.outcome === "success" || row.outcome === "cancelled"
        ? null
        : row.message,
  }));
}

export async function listMcpCalls(
  scope: ViewScope,
  filter: McpCallFilter = {},
  cursor?: string,
): Promise<ViewPage<McpCallSummary>> {
  await authorizeLogs(
    scope.kind === "workspace" ? scope : { adminId: scope.userId },
  );
  const query = criteria(scope, filter);
  const after = cursor
    ? streamCursorSchema.parse(
        (() => {
          const value = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
          ) as { at: string; id: string };
          return { createdAt: value.at, id: value.id };
        })(),
      )
    : null;
  const keyset = after
    ? Prisma.sql`AND (e."createdAt", e.id) < (${new Date(after.createdAt)}, ${after.id})`
    : Prisma.empty;
  const canonical = canonicalCalls(query.workspaceId, filter.source);
  const [rows, stats] = await Promise.all([
    db.$queryRaw<
      CallRow[]
    >(Prisma.sql`${canonical} SELECT e.* ${searchableCalls}
      WHERE ${query.where} ${keyset} ORDER BY e."createdAt" DESC, e.id DESC LIMIT 51`),
    db.$queryRaw<
      ViewStats[]
    >(Prisma.sql`${canonical} SELECT count(*)::int AS total,
      count(*) FILTER (WHERE e.outcome IN ('success', 'cancelled'))::int AS success,
      count(*) FILTER (WHERE e.outcome NOT IN ('success', 'cancelled'))::int AS error,
      count(*) FILTER (WHERE e."durationMs" >= ${query.slowMs})::int AS slow,
      avg(e."durationMs")::float8 AS "averageDurationMs"
      ${searchableCalls} WHERE ${query.where}`),
  ]);
  const page = rows.slice(0, 50);
  return {
    items: await summaries(page),
    nextCursor: rows.length > 50 ? logCursor(page[49]) : null,
    stats: stats[0],
  };
}

export async function pollMcpCalls(
  scope: ViewScope,
  filter: McpCallFilter,
  after: StreamCursor,
  until?: string,
): Promise<{
  items: { item: McpCallSummary; cursor: StreamCursor }[];
  nextCursor: StreamCursor;
}> {
  await authorizeLogs(
    scope.kind === "workspace" ? scope : { adminId: scope.userId },
  );
  streamCursorSchema.parse(after);
  const query = criteria(scope, filter, until);
  const rows = await db.$queryRaw<
    CallRow[]
  >(Prisma.sql`${canonicalCalls(query.workspaceId, filter.source)}
    SELECT e.* ${searchableCalls} WHERE ${query.where}
    AND (e."createdAt", e.id) > (${new Date(after.createdAt)}, ${after.id})
    ORDER BY e."createdAt" ASC, e.id ASC LIMIT 50`);
  const items = (await summaries(rows)).map((item, index) => ({
    item,
    cursor: {
      createdAt: rows[index].createdAt.toISOString(),
      id: rows[index].id,
    },
  }));
  return { items, nextCursor: items.at(-1)?.cursor ?? after };
}

function envelope(value: unknown): {
  request: JsonValue | null;
  response: JsonValue | null;
} {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const payload =
    data?.payload &&
    typeof data.payload === "object" &&
    !Array.isArray(data.payload)
      ? (data.payload as Record<string, JsonValue>)
      : null;
  const result = {
    request: payload?.request ?? null,
    response: payload?.response ?? null,
  };
  // Gateway envelopes historically stored the request as JSON text; expose the protocol object.
  for (const field of ["request", "response"] as const) {
    if (typeof result[field] === "string") {
      try {
        result[field] = JSON.parse(result[field]) as JsonValue;
      } catch {
        /* Retain truncated or non-JSON text. */
      }
    }
  }
  return result;
}

export async function getMcpCall(
  scope: ViewScope,
  id: string,
): Promise<McpCallDetail | null> {
  await authorizeLogs(
    scope.kind === "workspace" ? scope : { adminId: scope.userId },
  );
  const workspaceId = scope.workspaceId;
  const selected = await db.logEvent.findFirst({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      AND: [
        {
          OR: [
            {
              domain: "mcp",
              eventName: { in: ["gateway.request", "mcp.rpc", "mcp.internal"] },
            },
            { domain: "agent", eventName: "sandbox.tool" },
          ],
        },
        { OR: [{ id }, { callId: id }] },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!selected) return null;
  // Resolve only inside the selected event's workspace, including for cross-workspace admins.
  const related =
    selected.domain === "agent"
      ? []
      : await db.logEvent.findMany({
          where: {
            workspaceId: selected.workspaceId,
            domain: "mcp",
            eventName: { in: ["gateway.request", "mcp.rpc", "mcp.internal"] },
            ...(selected.callId
              ? { callId: selected.callId }
              : {
                  callId: null,
                  traceId: selected.traceId,
                  deploymentId: selected.deploymentId,
                  rpcMethod: selected.rpcMethod,
                  toolName: selected.toolName,
                }),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
  const gateway = related.find((row) => row.eventName === "gateway.request");
  // Historical heuristic keys may repeat in a trace; retain the requested gateway when available.
  const canonical =
    !selected.callId && selected.eventName === "gateway.request"
      ? selected
      : (gateway ?? related[0] ?? selected);
  const upstream =
    canonical.eventName === "gateway.request"
      ? related
          .filter((row) => row.eventName === "mcp.rpc")
          .reduce<LogEvent | undefined>(
            (closest, row) =>
              !closest ||
              Math.abs(
                row.createdAt.getTime() - canonical.createdAt.getTime(),
              ) <
                Math.abs(
                  closest.createdAt.getTime() - canonical.createdAt.getTime(),
                )
                ? row
                : closest,
            undefined,
          )
      : undefined;
  const bodyScope =
    scope.kind === "workspace" ? scope : { adminId: scope.userId };
  const [body, upstreamBody, trace] = await Promise.all([
    getLogEvent(bodyScope, canonical.id),
    upstream ? getLogEvent(bodyScope, upstream.id) : null,
    db.logEvent.findMany({
      where: { workspaceId: canonical.workspaceId, traceId: canonical.traceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const attributes = canonical.attributes as {
    data?: { tokenId?: string; apiTokenId?: string };
  } | null;
  const fragment = canonical.path?.split("#")[1]?.split(":");
  const [summary] = await summaries([
    {
      ...canonical,
      tokenId:
        attributes?.data?.tokenId ?? attributes?.data?.apiTokenId ?? null,
      callMethod: canonical.rpcMethod ?? fragment?.[0] ?? null,
      callTool: canonical.toolName ?? fragment?.[1] ?? null,
    },
  ]);
  return {
    summary,
    source:
      canonical.domain === "agent"
        ? "tools"
        : canonical.eventName === "mcp.internal"
          ? "internal"
          : "calls",
    ...envelope(body?.detail?.data),
    ...(upstream && upstreamBody
      ? {
          upstream: {
            eventId: upstream.id,
            ...envelope(upstreamBody.detail?.data),
            bodyState: upstreamBody.detailState as BodyState,
          },
        }
      : {}),
    trace: trace.map((row) => ({
      id: row.id,
      time: row.createdAt.toISOString(),
      level: row.level,
      message: row.message,
      eventName: row.eventName,
    })),
    bodyState: body?.detailState ?? "unavailable",
  };
}
