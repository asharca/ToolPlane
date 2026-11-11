import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeLogs } from "./queries";

export const performanceDimensions = [
  "route",
  "mcpTool",
  "model",
  "agentTool",
] as const;
export type PerformanceDimension = (typeof performanceDimensions)[number];
export type PerformanceRow = {
  key: string;
  secondary: string | null;
  count: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  lastAt: Date;
  logsQuery: Record<string, string>;
};

const performanceInputSchema = z
  .object({
    dimension: z.enum(performanceDimensions),
    since: z.date(),
    until: z.date(),
    workspaceId: z.string().min(1).max(200).optional(),
    sort: z.enum(["p95", "count", "errors"]).default("p95"),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine(
    ({ since, until }) =>
      until >= since && until.getTime() - since.getTime() <= 31 * 86_400_000,
    "Maximum window is 31 days",
  );

type PerformanceConfig = {
  key: Prisma.Sql;
  secondary: Prisma.Sql;
  where: Prisma.Sql;
  logsQuery: Record<string, string>;
  keyFilter: string;
  secondaryFilter: string | null;
};

const dimensions: Record<PerformanceDimension, PerformanceConfig> = {
  route: {
    key: Prisma.sql`path`,
    secondary: Prisma.sql`method`,
    where: Prisma.sql`domain = 'http' AND "eventName" = 'http.request'`,
    logsQuery: { domain: "http", eventName: "http.request" },
    keyFilter: "path",
    secondaryFilter: "method",
  },
  mcpTool: {
    key: Prisma.sql`"toolName"`,
    secondary: Prisma.sql`"deploymentId"`,
    where: Prisma.sql`domain = 'mcp' AND "eventName" = 'gateway.request' AND "rpcMethod" = 'tools/call'`,
    logsQuery: {
      domain: "mcp",
      eventName: "gateway.request",
      rpcMethod: "tools/call",
    },
    keyFilter: "toolName",
    secondaryFilter: "deploymentId",
  },
  model: {
    key: Prisma.sql`model`,
    secondary: Prisma.sql`"providerId"`,
    where: Prisma.sql`"eventName" IN ('model.call', 'model.request')`,
    logsQuery: { eventNames: "model.call,model.request" },
    keyFilter: "model",
    secondaryFilter: "providerId",
  },
  agentTool: {
    key: Prisma.sql`"toolName"`,
    secondary: Prisma.sql`NULL::text`,
    where: Prisma.sql`domain = 'agent' AND "eventName" = 'sandbox.tool'`,
    logsQuery: { domain: "agent", eventName: "sandbox.tool" },
    keyFilter: "toolName",
    secondaryFilter: null,
  },
};

/**
 * Admin-only, bounded event aggregates. Null durations remain in counts but do
 * not contribute to percentiles. Drill-down retains snapshot IDs, including
 * deleted providers/deployments, rather than filtering by mutable display names.
 */
export async function getPerformanceBreakdown(
  scope: { adminId: string },
  input: {
    dimension: PerformanceDimension;
    since: Date;
    until: Date;
    workspaceId?: string;
    sort?: "p95" | "count" | "errors";
    limit?: number;
  },
): Promise<PerformanceRow[]> {
  await authorizeLogs(scope);
  const { dimension, since, until, workspaceId, sort, limit } =
    performanceInputSchema.parse(input);
  const config = dimensions[dimension];
  const conditions = [
    Prisma.sql`"createdAt" >= ${since}`,
    Prisma.sql`"createdAt" <= ${until}`,
    config.where,
    Prisma.sql`${config.key} IS NOT NULL`,
  ];
  if (workspaceId) conditions.push(Prisma.sql`"workspaceId" = ${workspaceId}`);
  const orderBy = {
    p95: Prisma.sql`"p95Ms" DESC NULLS LAST, count DESC, key ASC, secondary ASC NULLS FIRST`,
    count: Prisma.sql`count DESC, "p95Ms" DESC NULLS LAST, key ASC, secondary ASC NULLS FIRST`,
    errors: Prisma.sql`errors DESC, count DESC, key ASC, secondary ASC NULLS FIRST`,
  }[sort];
  const rows = await db.$queryRaw<
    Array<Omit<PerformanceRow, "logsQuery">>
  >(Prisma.sql`
    SELECT ${config.key} AS key, ${config.secondary} AS secondary,
      count(*)::int AS count,
      count(*) FILTER (WHERE outcome IN ('error', 'timeout'))::int AS errors,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY "durationMs") AS "p50Ms",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS "p95Ms",
      percentile_cont(0.99) WITHIN GROUP (ORDER BY "durationMs") AS "p99Ms",
      max("durationMs") AS "maxMs", max("createdAt") AS "lastAt"
    FROM "LogEvent"
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1, 2
    ORDER BY ${orderBy}
    LIMIT ${limit}`);

  const ids = rows.flatMap((row) =>
    row.secondary === null ? [] : [row.secondary],
  );
  const names = new Map<string, string | null>();
  if (dimension === "mcpTool" && ids.length) {
    const deployments = await db.deployment.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const deployment of deployments)
      names.set(deployment.id, deployment.name);
  } else if (dimension === "model" && ids.length) {
    const providers = await db.modelProvider.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const provider of providers) names.set(provider.id, provider.name);
  }

  return rows.map((row) => {
    const logsQuery: Record<string, string> = {
      tab: "all",
      ...config.logsQuery,
      [config.keyFilter]: row.key,
      since: since.toISOString(),
      until: until.toISOString(),
    };
    if (workspaceId) logsQuery.workspaceId = workspaceId;
    if (config.secondaryFilter) {
      if (row.secondary === null) logsQuery.missing = config.secondaryFilter;
      else logsQuery[config.secondaryFilter] = row.secondary;
    }
    return {
      ...row,
      secondary:
        dimension === "mcpTool" || dimension === "model"
          ? row.secondary === null
            ? null
            : (names.get(row.secondary) ?? null)
          : row.secondary,
      logsQuery,
    };
  });
}
