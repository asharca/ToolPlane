import "server-only";
import { TaskState } from "@a2a-js/sdk";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  authorizeLogs,
  getA2aMetadata,
  getLogEvent,
  resolveLogFilters,
} from "../queries";
import { resolveNames, type NameReference, type ResolvedNames } from "./names";
import type {
  A2AArtifactView,
  A2AMessageView,
  A2ATaskDetail,
  A2ATaskFilter,
  A2ATaskNode,
  A2ATaskSummary,
  JsonValue,
  Party,
  TimelineEntry,
  ViewPage,
  ViewScope,
  ViewStats,
} from "./types";

type TaskRow = {
  taskId: string;
  rootTaskId: string;
  parentTaskId: string | null;
  workspaceId: string;
  contextId: string | null;
  state: string;
  startedAt: Date;
  settledAt: Date | null;
  durationMs: number | null;
  direction: A2ATaskSummary["direction"];
  fromKind: Party["kind"];
  fromId: string | null;
  toKind: Party["kind"];
  toId: string | null;
  agentId: string | null;
  endpointId: string | null;
  error: string | null;
  childCount: number;
  key: string;
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
const logScope = (scope: ViewScope) =>
  scope.kind === "workspace"
    ? { userId: scope.userId, workspaceId: scope.workspaceId }
    : { adminId: scope.userId };
const workspaceId = (scope: ViewScope, filter?: A2ATaskFilter) =>
  scope.workspaceId ??
  (scope.kind === "admin" ? filter?.workspaceId : undefined);
const terminalStates = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];
const errorStates = ["TASK_STATE_FAILED", "TASK_STATE_REJECTED"];

function filters(scope: ViewScope, filter: A2ATaskFilter) {
  const durations = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
  };
  const until = filter.until ?? new Date().toISOString();
  const range = filter.range ?? "24h";
  if (range === "custom" && (!filter.since || !filter.until))
    throw new Error("Custom range requires since and until");
  return resolveLogFilters({
    ...filter,
    workspaceId: workspaceId(scope, filter),
    since:
      filter.since ??
      new Date(
        new Date(until).getTime() -
          (range === "custom" ? 86_400_000 : durations[range]),
      ).toISOString(),
    until,
  });
}

/** Only ledger identity/state columns are selected. Ledger conversation JSON is never read. */
function taskTables(scope: ViewScope, selectedWorkspace?: string) {
  const ws = scope.workspaceId ?? selectedWorkspace;
  const logWorkspace = ws
    ? Prisma.sql`AND e."workspaceId" = ${ws}`
    : Prisma.empty;
  const ledgerWorkspace = ws
    ? Prisma.sql`WHERE c."workspaceId" = ${ws}`
    : Prisma.empty;
  const stateCases = Object.entries(TaskState)
    .filter(([, value]) => typeof value === "number")
    .map(
      ([name, value]) =>
        Prisma.sql`WHEN ${value} THEN ${name.startsWith("TASK_STATE_") ? name : `TASK_STATE_${name}`}`,
    );
  return Prisma.sql`
    scoped_events AS (
      SELECT e.*, e.attributes->'data'->'a2a' AS meta
      FROM "LogEvent" e
      WHERE e.domain = 'a2a' AND e."workspaceId" IS NOT NULL
        AND NULLIF(e.attributes->'data'->'a2a'->>'taskId', '') IS NOT NULL ${logWorkspace}
    ), log_tasks AS (
      SELECT e."workspaceId", e.meta->>'taskId' AS "taskId",
        COALESCE((array_agg(NULLIF(e.meta->>'rootTaskId', '') ORDER BY e."createdAt", e.id)
          FILTER (WHERE NULLIF(e.meta->>'rootTaskId', '') IS NOT NULL))[1], e.meta->>'taskId') AS "rootTaskId",
        (array_agg(e.meta->>'parentTaskId' ORDER BY e."createdAt", e.id) FILTER (WHERE e.meta->>'parentTaskId' IS NOT NULL))[1] AS "parentTaskId",
        (array_agg(e.meta->>'contextId' ORDER BY e."createdAt", e.id) FILTER (WHERE e.meta->>'contextId' IS NOT NULL))[1] AS "contextId",
        COALESCE((array_agg(e.meta->>'taskState' ORDER BY e."createdAt" DESC, e.id DESC)
          FILTER (WHERE e.meta->>'taskState' IS NOT NULL))[1], 'TASK_STATE_UNSPECIFIED') AS state,
        min(e."createdAt" - CASE WHEN e."eventName" = 'a2a.task.settled' AND e."durationMs" >= 0
          THEN e."durationMs" * interval '1 millisecond' ELSE interval '0 milliseconds' END) AS "startedAt",
        max(e."createdAt") FILTER (WHERE e.meta->>'taskState' IN (${Prisma.join(terminalStates)})) AS "settledAt",
        (array_agg(e.meta->>'direction' ORDER BY (e."eventName" = 'a2a.request') DESC, e."createdAt", e.id)
          FILTER (WHERE e.meta->>'direction' IS NOT NULL))[1] AS direction,
        (array_agg(e."agentId" ORDER BY e."createdAt", e.id) FILTER (WHERE e."agentId" IS NOT NULL))[1] AS "agentId",
        (array_agg(e."actorId" ORDER BY e."createdAt", e.id) FILTER (WHERE e."actorId" IS NOT NULL))[1] AS "actorId",
        (array_agg(e.meta->>'endpointId' ORDER BY e."createdAt", e.id) FILTER (WHERE e.meta->>'endpointId' IS NOT NULL))[1] AS "endpointId",
        (array_agg(e.meta->>'clientId' ORDER BY e."createdAt", e.id) FILTER (WHERE e.meta->>'clientId' IS NOT NULL))[1] AS "clientId",
        (array_agg(e.meta->>'remoteAgentId' ORDER BY e."createdAt", e.id) FILTER (WHERE e.meta->>'remoteAgentId' IS NOT NULL))[1] AS "remoteAgentId",
        (array_agg(COALESCE(e."errorCode", e.message) ORDER BY e."createdAt" DESC, e.id DESC)
          FILTER (WHERE e.outcome IN ('error', 'timeout', 'denied')))[1] AS error,
        string_agg(concat_ws(' ', e.message, e."rpcMethod", e."errorCode", e.meta->>'taskId', e.meta->>'contextId'), ' ') AS search
      FROM scoped_events e GROUP BY e."workspaceId", e.meta->>'taskId'
    ), ledger_tasks AS (
      SELECT t.id AS "taskId", c."workspaceId", t."contextId", COALESCE(NULLIF(t."rootTaskId", ''), t.id) AS "rootTaskId",
        t."parentTaskId", CASE t.state ${Prisma.join(stateCases, " ")} ELSE 'TASK_STATE_UNSPECIFIED' END AS state,
        t."createdAt" AS "startedAt", t."completedAt" AS "settledAt",
        CASE WHEN c."targetKind" = 'remote' THEN 'outbound' WHEN c."endpointId" IS NOT NULL THEN 'inbound' ELSE 'internal' END AS direction,
        c."agentId", c."endpointId", c."clientId", c."remoteAgentId",
        COALESCE(t.grant->>'sourceAgentId', t.grant->'ancestorAgentIds'->>-1) AS "sourceAgentId",
        t.grant->>'actorId' AS "actorId"
      FROM "A2ATask" t JOIN "A2AContext" c ON c.id = t."contextId" ${ledgerWorkspace}
    ), merged_tasks AS (
      SELECT COALESCE(t."taskId", l."taskId") AS "taskId", COALESCE(t."workspaceId", l."workspaceId") AS "workspaceId",
        COALESCE(t."rootTaskId", l."rootTaskId") AS "rootTaskId", COALESCE(t."parentTaskId", l."parentTaskId") AS "parentTaskId",
        COALESCE(t."contextId", l."contextId") AS "contextId", COALESCE(t.state, l.state) AS state,
        COALESCE(t."startedAt", l."startedAt") AS "startedAt",
        CASE WHEN COALESCE(t.state, l.state) IN (${Prisma.join(terminalStates)})
          THEN COALESCE(t."settledAt", l."settledAt") END AS "settledAt",
        COALESCE(t.direction, l.direction, 'internal') AS direction,
        COALESCE(t."agentId", l."agentId") AS "agentId", COALESCE(t."endpointId", l."endpointId") AS "endpointId",
        COALESCE(t."clientId", l."clientId") AS "clientId", COALESCE(t."remoteAgentId", l."remoteAgentId") AS "remoteAgentId",
        COALESCE(t."actorId", l."actorId") AS "actorId", t."sourceAgentId", l.error, l.search
      FROM ledger_tasks t FULL JOIN log_tasks l ON l."taskId" = t."taskId" AND l."workspaceId" = t."workspaceId"
    ), tasks AS (
      SELECT m.*,
        CASE WHEN COALESCE(m."sourceAgentId", parent."agentId") IS NOT NULL THEN 'agent' WHEN m.direction = 'outbound' AND m."agentId" IS NOT NULL THEN 'agent'
          WHEN m."clientId" IS NOT NULL THEN 'client' WHEN m."actorId" IS NOT NULL THEN 'user' ELSE 'unknown' END AS "fromKind",
        COALESCE(m."sourceAgentId", parent."agentId", CASE WHEN m.direction = 'outbound' THEN m."agentId" END, m."clientId", m."actorId") AS "fromId",
        CASE WHEN m."remoteAgentId" IS NOT NULL THEN 'remote-agent' WHEN m."agentId" IS NOT NULL AND m.direction <> 'outbound' THEN 'agent'
          WHEN m."endpointId" IS NOT NULL THEN 'endpoint' ELSE 'unknown' END AS "toKind",
        COALESCE(m."remoteAgentId", CASE WHEN m.direction <> 'outbound' THEN m."agentId" END, m."endpointId") AS "toId",
        CASE WHEN m."settledAt" IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (m."settledAt" - m."startedAt")) * 1000)::double precision END AS "durationMs"
      FROM merged_tasks m LEFT JOIN merged_tasks parent ON parent."taskId" = m."parentTaskId" AND parent."workspaceId" = m."workspaceId"
    ), roots AS (
      SELECT DISTINCT ON (t."workspaceId", t."rootTaskId") t.*,
        (SELECT count(*)::int FROM tasks child WHERE child."workspaceId" = t."workspaceId"
          AND child."rootTaskId" = t."rootTaskId" AND child."taskId" <> t."rootTaskId") AS "childCount",
        concat(t."workspaceId", ':', t."rootTaskId") AS key
      FROM tasks t ORDER BY t."workspaceId", t."rootTaskId", (t."taskId" = t."rootTaskId") DESC, t."startedAt", t."taskId"
    )`;
}

function rootConditions(scope: ViewScope, filter: A2ATaskFilter) {
  const parsed = filters(scope, filter);
  const conditions = [
    Prisma.sql`r."startedAt" >= ${parsed.since} AND r."startedAt" <= ${parsed.until}`,
  ];
  if (filter.state) conditions.push(Prisma.sql`r.state = ${filter.state}`);
  if (filter.direction)
    conditions.push(Prisma.sql`r.direction = ${filter.direction}`);
  if (filter.agentId)
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM tasks t WHERE t."workspaceId" = r."workspaceId" AND t."rootTaskId" = r."rootTaskId"
    AND (t."agentId" = ${filter.agentId} OR (t."fromKind" = 'agent' AND t."fromId" = ${filter.agentId})
      OR EXISTS (SELECT 1 FROM "AgentEndpoint" ep WHERE ep.id = t."endpointId" AND ep."workspaceId" = t."workspaceId" AND ep."sourceAgentId" = ${filter.agentId})))`);
  if (parsed.q) {
    const pattern = `%${parsed.q}%`;
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM tasks t WHERE t."workspaceId" = r."workspaceId" AND t."rootTaskId" = r."rootTaskId" AND (
      concat_ws(' ', t."taskId", t."contextId", t."rootTaskId", t."fromId", t."toId", t.state, t.direction, t.error, t.search) ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM "Agent" a WHERE a."workspaceId" = t."workspaceId" AND a.id IN (t."agentId", t."fromId", t."toId") AND a.name ILIKE ${pattern})
      OR EXISTS (SELECT 1 FROM "RemoteA2AAgent" a WHERE a."workspaceId" = t."workspaceId" AND a.id = t."remoteAgentId" AND a.name ILIKE ${pattern})
      OR EXISTS (SELECT 1 FROM "AgentEndpoint" ep WHERE ep."workspaceId" = t."workspaceId" AND ep.id = t."endpointId" AND ep.name ILIKE ${pattern})
      OR EXISTS (SELECT 1 FROM "AgentApiClient" client JOIN "AgentEndpoint" ep ON ep.id = client."endpointId"
        WHERE ep."workspaceId" = t."workspaceId" AND client.id = t."clientId" AND client.name ILIKE ${pattern})
    ))`);
  }
  return Prisma.join(conditions, " AND ");
}

function references(rows: TaskRow[]): NameReference[] {
  return rows
    .map((row) => {
      const ref: NameReference = {
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        endpointId: row.endpointId,
      };
      for (const [kind, id] of [
        [row.fromKind, row.fromId],
        [row.toKind, row.toId],
      ] as const) {
        if (kind === "agent") {
          // Sender and receiver can be different agents: each gets its own reference below.
          continue;
        }
        if (kind === "user") ref.actorId = id;
        if (kind === "client") ref.clientId = id;
        if (kind === "remote-agent") ref.remoteAgentId = id;
        if (kind === "endpoint") ref.endpointId = id;
      }
      return ref;
    })
    .concat(
      rows.flatMap((row) =>
        [
          row.fromKind === "agent" ? row.fromId : null,
          row.toKind === "agent" ? row.toId : null,
        ]
          .filter((id): id is string => !!id)
          .map((id) => ({ workspaceId: row.workspaceId, agentId: id })),
      ),
    );
}
function summary(row: TaskRow, names: ResolvedNames): A2ATaskSummary {
  return {
    taskId: row.rootTaskId,
    contextId: row.contextId,
    rootTaskId: row.rootTaskId,
    workspace: names.entity("workspace", row.workspaceId, row.workspaceId),
    from: names.party(row.fromKind, row.fromId, row.workspaceId),
    to: names.party(row.toKind, row.toId, row.workspaceId),
    direction: row.direction,
    state: row.state,
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    childCount: row.childCount,
    ...(row.error && errorStates.includes(row.state)
      ? { error: row.error }
      : {}),
  };
}

export async function listA2ATasks(
  scope: ViewScope,
  filter: A2ATaskFilter,
  cursor?: string,
): Promise<ViewPage<A2ATaskSummary>> {
  await authorizeLogs(logScope(scope));
  const tables = taskTables(scope, workspaceId(scope, filter));
  const where = rootConditions(scope, filter);
  const parsed = cursor
    ? pageCursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString()),
      )
    : null;
  const page = parsed
    ? Prisma.sql`AND (r."startedAt", r.key) < (${new Date(parsed.at)}, ${parsed.id})`
    : Prisma.empty;
  const [rows, totals] = await Promise.all([
    db.$queryRaw<TaskRow[]>(
      Prisma.sql`WITH ${tables} SELECT r.* FROM roots r WHERE ${where} ${page} ORDER BY r."startedAt" DESC, r.key DESC LIMIT 51`,
    ),
    db.$queryRaw<
      ViewStats[]
    >(Prisma.sql`WITH ${tables} SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.state = 'TASK_STATE_COMPLETED')::int AS success,
      count(*) FILTER (WHERE r.state IN (${Prisma.join(errorStates)}))::int AS error,
      count(*) FILTER (WHERE r."durationMs" >= 2000)::int AS slow,
      avg(r."durationMs")::double precision AS "averageDurationMs" FROM roots r WHERE ${where}`),
  ]);
  const items = rows.slice(0, 50);
  const names = await resolveNames(references(items));
  const last = items[items.length - 1];
  return {
    items: items.map((row) => summary(row, names)),
    nextCursor:
      rows.length > 50 && last
        ? Buffer.from(
            JSON.stringify({ at: last.startedAt.toISOString(), id: last.key }),
          ).toString("base64url")
        : null,
    stats: totals[0],
  };
}

function object(
  value: JsonValue | undefined,
): { [key: string]: JsonValue } | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/** Chat content is derived exclusively from authorized, audited, redacted protocol bodies. */
function collectContent(
  value: JsonValue | undefined,
  taskId: string,
  time: string,
  messages: Map<string, A2AMessageView>,
  artifacts: Map<string, A2AArtifactView>,
  depth = 0,
) {
  if (depth > 24 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value)
      collectContent(entry, taskId, time, messages, artifacts, depth + 1);
    return;
  }
  const data = object(value);
  if (!data) return;
  const id =
    typeof data.taskId === "string"
      ? data.taskId
      : typeof data.id === "string" &&
          (object(data.status) || Array.isArray(data.history))
        ? data.id
        : taskId;
  if (typeof data.role === "string" && Array.isArray(data.parts)) {
    const messageId =
      typeof data.messageId === "string"
        ? data.messageId
        : JSON.stringify([data.role, data.parts]);
    const key = `${id}:${messageId}`;
    messages.set(key, {
      id: messageId,
      taskId: id,
      role: data.role,
      parts: data.parts,
      time: messages.get(key)?.time ?? time,
    });
  }
  if (typeof data.artifactId === "string" && Array.isArray(data.parts)) {
    const key = `${id}:${data.artifactId}`;
    artifacts.set(key, {
      id: data.artifactId,
      taskId: id,
      name: typeof data.name === "string" ? data.name : null,
      description:
        typeof data.description === "string" ? data.description : null,
      parts: [...data.parts],
    });
  }
  const artifact = object(data.artifact);
  if (data.append === true && artifact) {
    const artifactId =
      typeof artifact.artifactId === "string" ? artifact.artifactId : null;
    const existing = artifactId
      ? artifacts.get(`${id}:${artifactId}`)
      : undefined;
    if (existing && Array.isArray(artifact.parts)) {
      existing.parts.push(...artifact.parts);
      return;
    }
  }
  for (const key of [
    "params",
    "request",
    "response",
    "result",
    "task",
    "message",
    "history",
    "artifacts",
    "status",
    "statusUpdate",
    "artifactUpdate",
    "artifact",
    "events",
    "data",
  ]) {
    if (data[key] !== undefined)
      collectContent(data[key], id, time, messages, artifacts, depth + 1);
  }
  // MCP transports wrap the A2A wire envelope in text content blocks.
  if (Array.isArray(data.content))
    for (const block of data.content) {
      const text = object(block)?.text;
      if (typeof text === "string") {
        try {
          collectContent(
            JSON.parse(text) as JsonValue,
            id,
            time,
            messages,
            artifacts,
            depth + 1,
          );
        } catch {
          /* Not a JSON protocol block. */
        }
      }
    }
}

export async function getA2ATask(
  scope: ViewScope,
  taskId: string,
): Promise<A2ATaskDetail | null> {
  await authorizeLogs(logScope(scope));
  const tables = taskTables(scope);
  const found = await db.$queryRaw<
    TaskRow[]
  >(Prisma.sql`WITH ${tables} SELECT t.* FROM tasks t
    WHERE t."taskId" = ${taskId} OR t."rootTaskId" = ${taskId} ORDER BY (t."taskId" = ${taskId}) DESC LIMIT 1`);
  const task = found[0];
  if (!task) return null;
  const [roots, treeRows, events, ledgerTimeline] = await Promise.all([
    db.$queryRaw<TaskRow[]>(
      Prisma.sql`WITH ${tables} SELECT r.* FROM roots r WHERE r."rootTaskId" = ${task.rootTaskId} AND r."workspaceId" = ${task.workspaceId}`,
    ),
    db.$queryRaw<TaskRow[]>(
      Prisma.sql`WITH ${tables} SELECT t.* FROM tasks t WHERE t."rootTaskId" = ${task.rootTaskId} AND t."workspaceId" = ${task.workspaceId} ORDER BY t."startedAt", t."taskId"`,
    ),
    db.$queryRaw<
      {
        id: string;
        createdAt: Date;
        level: string;
        message: string;
        attributes: JsonValue | null;
        eventName: string;
      }[]
    >(Prisma.sql`
      WITH ${tables} SELECT e.id, e."createdAt", e.level, e.message, e.attributes, e."eventName"
      FROM scoped_events e JOIN tasks t ON t."taskId" = e.meta->>'taskId' AND t."workspaceId" = e."workspaceId"
      WHERE t."rootTaskId" = ${task.rootTaskId} AND t."workspaceId" = ${task.workspaceId} ORDER BY e."createdAt", e.id`),
    db.$queryRaw<
      {
        taskId: string;
        sequence: number;
        createdAt: Date;
        state: string | null;
      }[]
    >(Prisma.sql`
      WITH ${tables} SELECT e."taskId", e.sequence, e."createdAt",
        COALESCE(e.payload->'statusUpdate'->'status'->>'state', e.payload->'task'->'status'->>'state') AS state
      FROM "A2AEvent" e JOIN tasks t ON t."taskId" = e."taskId"
      JOIN "A2ATask" ledger ON ledger.id = e."taskId" JOIN "A2AContext" c ON c.id = ledger."contextId" AND c."workspaceId" = t."workspaceId"
      WHERE t."workspaceId" = ${task.workspaceId} AND t."rootTaskId" = ${task.rootTaskId} ORDER BY e."createdAt", e.sequence`),
  ]);
  const root = roots[0];
  if (!root) return null;
  const names = await resolveNames(references([root, ...treeRows]));
  const tree: A2ATaskNode[] = treeRows.map((row) => ({
    taskId: row.taskId,
    parentTaskId: row.parentTaskId,
    rootTaskId: row.rootTaskId,
    state: row.state,
    from: names.party(row.fromKind, row.fromId, row.workspaceId),
    to: names.party(row.toKind, row.toId, row.workspaceId),
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }));
  const messages = new Map<string, A2AMessageView>();
  const artifacts = new Map<string, A2AArtifactView>();
  const protocol: A2ATaskDetail["protocol"] = [];
  const timeline: TimelineEntry[] = ledgerTimeline.flatMap(
    (entry): TimelineEntry[] => {
      const state = entry.state;
      if (!state) return [];
      return [
        {
          id: `ledger:${entry.taskId}:${entry.sequence}`,
          taskId: entry.taskId,
          time: entry.createdAt.toISOString(),
          level: errorStates.includes(state) ? "error" : "info",
          message: state,
          state,
          eventName: "a2a.task.state",
        },
      ];
    },
  );
  for (const event of events) {
    const metadata = getA2aMetadata(event.attributes);
    timeline.push({
      id: event.id,
      time: event.createdAt.toISOString(),
      level: event.level,
      message: event.message,
      state: metadata?.taskState,
      taskId: metadata?.taskId,
      eventName: event.eventName,
    });
    const detail = await getLogEvent(logScope(scope), event.id);
    if (!detail) continue;
    const payload = object(
      object(detail.detail?.data as JsonValue | undefined)?.payload,
    );
    const request = payload?.request ?? null;
    const response = payload?.response ?? null;
    protocol.push({
      eventId: event.id,
      request,
      response,
      bodyState: detail.detailState,
    });
    if (
      detail.detailState === "available" ||
      detail.detailState === "truncated"
    ) {
      const id = metadata?.taskId ?? task.rootTaskId;
      collectContent(
        request,
        id,
        event.createdAt.toISOString(),
        messages,
        artifacts,
      );
      collectContent(
        response,
        id,
        event.createdAt.toISOString(),
        messages,
        artifacts,
      );
    }
  }
  timeline.sort(
    (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
  );
  return {
    summary: summary(root, names),
    tree,
    messages: [...messages.values()],
    artifacts: [...artifacts.values()],
    timeline,
    protocol,
  };
}

export async function pollA2ATasks(
  scope: ViewScope,
  filter: A2ATaskFilter,
  after: ChangeCursor,
  until?: string,
): Promise<{
  items: { item: A2ATaskSummary; cursor: ChangeCursor }[];
  nextCursor: ChangeCursor;
}> {
  await authorizeLogs(logScope(scope));
  changeCursorSchema.parse(after);
  if (until) z.string().datetime().parse(until);
  const ws = workspaceId(scope, filter);
  const stop = until ? new Date(until) : new Date();
  const tables = taskTables(scope, ws);
  const where = rootConditions(scope, filter);
  const changes = await db.$queryRaw<
    { id: string; createdAt: Date; rootTaskId: string; workspaceId: string }[]
  >(Prisma.sql`
    WITH ${tables}, changes AS (
      SELECT e.id, e."createdAt", t."rootTaskId", e."workspaceId"
      FROM scoped_events e JOIN tasks t ON t."taskId" = e.meta->>'taskId' AND t."workspaceId" = e."workspaceId"
      UNION ALL
      SELECT concat('ledger:', t.id) AS id, t."updatedAt" AS "createdAt", COALESCE(NULLIF(t."rootTaskId", ''), t.id) AS "rootTaskId", c."workspaceId"
      FROM "A2ATask" t JOIN "A2AContext" c ON c.id = t."contextId"
      WHERE ${ws ? Prisma.sql`c."workspaceId" = ${ws}` : Prisma.sql`TRUE`}
        AND NOT EXISTS (SELECT 1 FROM scoped_events e WHERE e."workspaceId" = c."workspaceId" AND e.meta->>'taskId' = t.id)
    ) SELECT * FROM changes WHERE ("createdAt", id) > (${new Date(after.createdAt)}, ${after.id})
      AND "createdAt" <= ${stop} ORDER BY "createdAt", id LIMIT 50`);
  if (!changes.length) return { items: [], nextCursor: after };
  const roots = await db.$queryRaw<
    TaskRow[]
  >(Prisma.sql`WITH ${tables} SELECT r.* FROM roots r
    WHERE ${where} AND (${Prisma.join(
      changes.map(
        (change) =>
          Prisma.sql`(r."workspaceId" = ${change.workspaceId} AND r."rootTaskId" = ${change.rootTaskId})`,
      ),
      " OR ",
    )})`);
  const names = await resolveNames(references(roots));
  const byKey = new Map(
    roots.map((row) => [
      JSON.stringify([row.workspaceId, row.rootTaskId]),
      summary(row, names),
    ]),
  );
  const items: { item: A2ATaskSummary; cursor: ChangeCursor }[] = [];
  for (const change of changes) {
    const item = byKey.get(
      JSON.stringify([change.workspaceId, change.rootTaskId]),
    );
    if (item)
      items.push({
        item,
        cursor: { createdAt: change.createdAt.toISOString(), id: change.id },
      });
  }
  const last = changes[changes.length - 1];
  return {
    items,
    nextCursor: { createdAt: last.createdAt.toISOString(), id: last.id },
  };
}
