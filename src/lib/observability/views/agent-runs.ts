import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeLogs } from "../queries";
import {
  getLedgerTaskDetail,
  listRunDelegations,
  logScope,
  taskTimeFilters,
  taskStateSql,
  taskErrorSql,
} from "./a2a-tasks";
import { listTaskMcpCalls } from "./mcp-calls";
import { resolveNames } from "./names";
import { entryRootSql } from "./task-origin";
import type {
  AgentRunDetail,
  AgentRunFilter,
  AgentRunSummary,
  ViewPage,
  ViewScope,
  ViewStats,
} from "./types";

type RunRow = {
  taskId: string;
  workspaceId: string;
  agentId: string;
  actorId: string;
  entryKind: AgentRunSummary["entryKind"];
  sourceId: string | null;
  sourceTitle: string | null;
  state: string;
  startedAt: Date;
  updatedAt: Date;
  settledAt: Date | null;
  durationMs: number | null;
  error: string | null;
  toolCallCount: number;
  delegationCount: number;
};
type ChangeCursor = { createdAt: string; id: string };
const changeCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().max(500),
});
const pageCursorSchema = z.object({
  at: z.string().datetime(),
  id: z.string().min(1).max(500),
});

function runTables(scope: ViewScope, workspaceId?: string) {
  const ws = scope.workspaceId ?? workspaceId;
  return Prisma.sql`runs AS (
    SELECT t.id AS "taskId", c."workspaceId", c."agentId", t.grant->>'actorId' AS "actorId",
      t.grant->'entryPolicy'->>'kind' AS "entryKind",
      CASE WHEN t.grant->'entryPolicy'->>'kind' = 'work' THEN work.id ELSE conv.id END AS "sourceId",
      CASE WHEN t.grant->'entryPolicy'->>'kind' = 'work' THEN work.title ELSE conv.title END AS "sourceTitle",
      ${taskStateSql("t")} AS state, ${taskErrorSql("t")} AS error,
      t."createdAt" AS "startedAt", t."updatedAt", t."completedAt" AS "settledAt",
      CASE WHEN t."completedAt" IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (t."completedAt" - t."createdAt")) * 1000)::double precision END AS "durationMs",
      (SELECT count(*)::int FROM "LogEvent" e WHERE e."taskId" = t.id AND e."workspaceId" = c."workspaceId" AND e.domain = 'agent' AND e."eventName" = 'sandbox.tool') AS "toolCallCount",
      (SELECT count(*)::int FROM "A2ATask" child JOIN "A2AContext" cc ON cc.id = child."contextId" WHERE child."parentTaskId" = t.id AND cc."workspaceId" = c."workspaceId") AS "delegationCount"
    FROM "A2ATask" t JOIN "A2AContext" c ON c.id = t."contextId"
    LEFT JOIN "Conversation" conv ON conv.id = COALESCE(t.grant->'entryPolicy'->>'conversationId', t.grant->'entryPolicy'->>'sourceId')
      AND conv."agentId" = c."agentId" AND EXISTS (SELECT 1 FROM "Agent" a WHERE a.id = conv."agentId" AND a."workspaceId" = c."workspaceId")
    LEFT JOIN "WorkSession" work ON work.id = t.grant->'entryPolicy'->>'sourceId' AND work."workspaceId" = c."workspaceId" AND work."agentId" = c."agentId"
    WHERE ${entryRootSql("t")} ${ws ? Prisma.sql`AND c."workspaceId" = ${ws}` : Prisma.empty}
  )`;
}

function conditions(scope: ViewScope, filter: AgentRunFilter) {
  const parsed = taskTimeFilters(scope, filter);
  const terms = [
    Prisma.sql`r."startedAt" >= ${parsed.since} AND r."startedAt" <= ${parsed.until}`,
  ];
  if (filter.agentId) terms.push(Prisma.sql`r."agentId" = ${filter.agentId}`);
  if (filter.entryKind)
    terms.push(Prisma.sql`r."entryKind" = ${filter.entryKind}`);
  if (filter.state) terms.push(Prisma.sql`r.state = ${filter.state}`);
  if (parsed.q) {
    const pattern = `%${parsed.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    terms.push(Prisma.sql`(concat_ws(' ', r."taskId", r."sourceTitle", r.state, r.error, r."entryKind") ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM "Agent" a WHERE a.id = r."agentId" AND a."workspaceId" = r."workspaceId" AND a.name ILIKE ${pattern}))`);
  }
  return Prisma.join(terms, " AND ");
}

async function summaries(rows: RunRow[]): Promise<AgentRunSummary[]> {
  const names = await resolveNames(rows);
  return rows.map((row) => ({
    taskId: row.taskId,
    workspace: names.entity("workspace", row.workspaceId, row.workspaceId),
    agent: names.entity("agent", row.agentId, row.workspaceId),
    actor: names.party("user", row.actorId, row.workspaceId),
    entryKind: row.entryKind,
    source: row.sourceId
      ? {
          kind: row.entryKind === "work" ? "work" : "conversation",
          id: row.sourceId,
          title: row.sourceTitle,
        }
      : null,
    state: row.state,
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    ...(row.error ? { error: row.error } : {}),
    toolCallCount: row.toolCallCount,
    delegationCount: row.delegationCount,
  }));
}

export async function listAgentRuns(
  scope: ViewScope,
  filter: AgentRunFilter = {},
  cursor?: string,
): Promise<ViewPage<AgentRunSummary>> {
  await authorizeLogs(logScope(scope));
  const tables = runTables(scope, filter.workspaceId);
  const where = conditions(scope, filter);
  const after = cursor
    ? pageCursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString()),
      )
    : null;
  const keyset = after
    ? Prisma.sql`AND (r."startedAt", r."taskId") < (${new Date(after.at)}, ${after.id})`
    : Prisma.empty;
  const [rows, stats] = await Promise.all([
    db.$queryRaw<RunRow[]>(
      Prisma.sql`WITH ${tables} SELECT r.* FROM runs r WHERE ${where} ${keyset} ORDER BY r."startedAt" DESC, r."taskId" DESC LIMIT 51`,
    ),
    db.$queryRaw<
      ViewStats[]
    >(Prisma.sql`WITH ${tables} SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.state = 'TASK_STATE_COMPLETED')::int AS success,
      count(*) FILTER (WHERE r.state IN ('TASK_STATE_FAILED', 'TASK_STATE_REJECTED'))::int AS error,
      count(*) FILTER (WHERE r."durationMs" >= 2000)::int AS slow, avg(r."durationMs")::double precision AS "averageDurationMs"
      FROM runs r WHERE ${where}`),
  ]);
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  return {
    items: await summaries(page),
    stats: stats[0],
    nextCursor:
      rows.length > 50 && last
        ? Buffer.from(
            JSON.stringify({
              at: last.startedAt.toISOString(),
              id: last.taskId,
            }),
          ).toString("base64url")
        : null,
  };
}

export async function getAgentRun(
  scope: ViewScope,
  taskId: string,
): Promise<AgentRunDetail | null> {
  await authorizeLogs(logScope(scope));
  const rows = await db.$queryRaw<RunRow[]>(
    Prisma.sql`WITH ${runTables(scope)} SELECT r.* FROM runs r WHERE r."taskId" = ${taskId}`,
  );
  if (!rows[0]) return null;
  // Shared disclosure audits ownership before reading any request, snapshot or event bodies.
  const detail = await getLedgerTaskDetail(scope, taskId, "runs");
  if (!detail) return null;
  const scoped = { ...scope, workspaceId: rows[0].workspaceId };
  const [delegations, toolCalls, mcpCalls, runSummaries] = await Promise.all([
    listRunDelegations(scoped, taskId),
    listTaskMcpCalls(scoped, taskId, "tools"),
    listTaskMcpCalls(scoped, taskId, "calls"),
    summaries(rows),
  ]);
  return {
    summary: runSummaries[0],
    messages: detail.messages,
    artifacts: detail.artifacts,
    timeline: detail.timeline,
    delegations,
    toolCalls,
    mcpCalls,
  };
}

export async function pollAgentRuns(
  scope: ViewScope,
  filter: AgentRunFilter,
  after: ChangeCursor,
  until?: string,
): Promise<{
  items: { item: AgentRunSummary; cursor: ChangeCursor }[];
  nextCursor: ChangeCursor;
}> {
  await authorizeLogs(logScope(scope));
  changeCursorSchema.parse(after);
  if (until) z.string().datetime().parse(until);
  const tables = runTables(scope, filter.workspaceId);
  const stop = until ? new Date(until) : new Date();
  const changes = await db.$queryRaw<
    (RunRow & { changeId: string; changedAt: Date })[]
  >(Prisma.sql`
    WITH ${tables}, changes AS (
      SELECT r."taskId", concat('ledger:', r."taskId") AS id, r."updatedAt" AS "createdAt" FROM runs r
      UNION ALL
      SELECT e."taskId", e.id, e."createdAt" FROM "LogEvent" e JOIN runs r ON r."taskId" = e."taskId" AND r."workspaceId" = e."workspaceId"
      UNION ALL
      SELECT r."taskId", concat('delegation:', child.id), child."updatedAt"
      FROM "A2ATask" child JOIN "A2AContext" c ON c.id = child."contextId"
      JOIN runs r ON r."taskId" = child."parentTaskId" AND r."workspaceId" = c."workspaceId"
    ) SELECT r.*, changes.id AS "changeId", changes."createdAt" AS "changedAt" FROM changes JOIN runs r ON r."taskId" = changes."taskId"
      WHERE ${conditions(scope, filter)} AND (changes."createdAt", changes.id) > (${new Date(after.createdAt)}, ${after.id})
      AND changes."createdAt" <= ${stop} ORDER BY changes."createdAt", changes.id LIMIT 50`);
  const items = (await summaries(changes)).map((item, index) => ({
    item,
    cursor: {
      createdAt: changes[index].changedAt.toISOString(),
      id: changes[index].changeId,
    },
  }));
  return { items, nextCursor: items.at(-1)?.cursor ?? after };
}
