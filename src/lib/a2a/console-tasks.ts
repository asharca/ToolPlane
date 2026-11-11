import { nativeUiView } from "@/lib/agents/execution/native-ui";
import "server-only";
import { createHash } from "node:crypto";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import { Task } from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { readTaskOutput } from "@/lib/agents/execution/live-output-read";
import type { LiveTaskOutput } from "@/lib/agents/execution/live-output-types";
import {
  assertLocalActor,
  assertLocalGrant,
  createLocalEntryGrant,
  createLocalRootGrant,
  LOCAL_LIMITS,
  localOwnerKey,
  localTarget,
} from "./local-policy";
import {
  isLocalGrant,
  isRemoteGrant,
  isWorkspaceGrant,
  type TaskGrant,
  type LocalA2AGrant,
} from "./principal";
import { remoteTarget } from "./remote-policy";
import { getTaskRow } from "./store";
import { historyView, jsonTask } from "./model";
import type { ConsoleActor } from "./console-service";
import { collaborationReservation } from "./collaboration-policy";

/** Console-only projection. Phase/ancestry are UI metadata, not new A2A wire fields. */
export type ConsoleTaskTree = {
  rootTaskId: string;
  restricted: boolean;
  nodes: Array<{
    id: string;
    parentTaskId: string | null;
    agentId: string;
    name: string;
    state: string;
    phase: string;
    pendingUiRequests?: number;
    cancelRequested: boolean;
    remoteState?: string;
    remoteOutcome?: "observed" | "unknown";
    authorizedReservation?: {
      currency: string;
      reservedMicros: number;
      limitMicros: number;
    };
    resumeCount: number;
    updatedAt: string;
    executionBackend?: "pi-sdk" | "omp" | "pi-harness";
    nativeOperationId?: string | null;
    contextId?: string;
  }>;
  selectedTask: Record<string, unknown>;
  selectedOutput?: LiveTaskOutput;
};

type ConsoleLocalTarget = { name: string; binding: string; targets: string[] };

/** History has read authority, never a freshly minted execution grant. */
async function retainedOmpTarget(grant: LocalA2AGrant) {
  const agent = await db.agent.findFirst({
    where: {
      ...ORDINARY_AGENT_FILTER,
      id: grant.agentId,
      workspaceId: grant.workspaceId,
      runtimeKind: "omp",
    },
    select: {
      name: true,
      a2aOutboundEnabled: true,
      subAgents: { select: { childId: true } },
    },
  });
  const revision = await db.agentRevision.findFirst({
    where: { id: grant.agentRevisionId, agentId: grant.agentId },
    select: { config: true },
  });
  if (!agent || !revision) throw new TaskNotFoundError();
  const config = AgentRevisionConfigSchema.parse(revision.config);
  if (
    config.runtimeKind !== "omp" ||
    config.ompConfigChecksum !== marketReleaseChecksum(config.ompConfig)
  )
    throw new TaskNotFoundError();
  return {
    name: agent.name,
    binding: createHash("sha256")
      .update(JSON.stringify([grant.agentId, grant.agentRevisionId]))
      .digest("hex"),
    targets:
      agent.a2aOutboundEnabled && config.a2a.outboundEnabled
        ? config.a2a.policy.targets
            .filter(
              (target) =>
                target.kind === "local" &&
                agent.subAgents.some(
                  (link) => link.childId === target.targetId,
                ),
            )
            .map((target) => target.targetId)
        : [],
  };
}

/** Execution controls retain actor, live policy, edge and revision authorization. */
export async function getConsoleMutationTaskTree(
  ctx: ConsoleActor,
  rootId: string,
  selectedId = rootId,
  historyLength = 0,
): Promise<ConsoleTaskTree> {
  if (
    !Number.isSafeInteger(historyLength) ||
    historyLength < 0 ||
    historyLength > 32
  )
    throw new UnsupportedOperationError("Invalid history length.");
  const stored = await db.a2ATask.findFirst({
    where: {
      id: rootId,
      parentTaskId: null,
      context: {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        targetKind: "local",
      },
    },
  });
  if (!stored) throw new TaskNotFoundError();
  const entry = stored.grant as unknown as TaskGrant;
  const historical = stored.executionBackend === "omp";
  if (historical) {
    await assertLocalActor(db, ctx.workspaceId, ctx.actorId);
    if (
      !isLocalGrant(entry) ||
      entry.actorId !== ctx.actorId ||
      entry.workspaceId !== ctx.workspaceId ||
      entry.agentId !== ctx.agentId ||
      entry.ownerKey !==
        localOwnerKey(ctx.workspaceId, ctx.agentId, ctx.actorId)
    )
      throw new TaskNotFoundError();
  }
  if (isLocalGrant(entry) && entry.entryPolicy && entry.actorId !== ctx.actorId)
    throw new TaskNotFoundError();
  if (!historical && isLocalGrant(entry) && entry.entryPolicy)
    await assertLocalGrant(entry);
  const authority = historical
    ? entry
    : isLocalGrant(entry) &&
        entry.entryPolicy &&
        entry.ancestorTaskIds.length === 0
      ? entry.ownerKey ===
        localOwnerKey(ctx.workspaceId, ctx.agentId, ctx.actorId)
        ? entry
        : await createLocalEntryGrant(
            db,
            ctx.workspaceId,
            ctx.agentId,
            ctx.actorId,
            entry.entryPolicy,
          )
      : await createLocalRootGrant(ctx.workspaceId, ctx.agentId, ctx.actorId);
  const root = historical ? stored : await getTaskRow(authority, rootId);
  if (root.parentTaskId || root.rootTaskId !== root.id)
    throw new TaskNotFoundError();
  const rows = await db.a2ATask.findMany({
    where: {
      rootTaskId: root.id,
      context: {
        targetKind: { in: ["local", "remote"] },
        workspaceId: ctx.workspaceId,
        expiresAt: { gt: new Date() },
      },
    },
    orderBy: [{ depth: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: LOCAL_LIMITS.tasksPerRoot + 1,
  });
  if (rows.length > LOCAL_LIMITS.tasksPerRoot)
    throw new UnsupportedOperationError(
      "Task tree exceeds its configured limit.",
    );
  const visible = new Map<string, (typeof rows)[number]>();
  const targets = new Map<string, ConsoleLocalTarget>();
  const nodes: ConsoleTaskTree["nodes"] = [];
  for (const row of rows) {
    const grant = row.grant as unknown as TaskGrant;
    if (
      !isWorkspaceGrant(grant) ||
      grant.actorId !== ctx.actorId ||
      grant.workspaceId !== ctx.workspaceId
    )
      continue;
    if (row.id === root.id) {
      if (
        !isLocalGrant(grant) ||
        grant.agentId !== ctx.agentId ||
        grant.ancestorTaskIds.length
      )
        continue;
    } else {
      const parent = row.parentTaskId
        ? visible.get(row.parentTaskId)
        : undefined;
      if (
        !parent ||
        grant.rootTaskId !== root.id ||
        grant.parentTaskId !== parent.id ||
        grant.ancestorTaskIds[0] !== root.id ||
        grant.ancestorTaskIds.at(-1) !== parent.id ||
        grant.ancestorTaskIds.length !== row.depth
      )
        continue;
      const parentGrant = parent.grant as unknown as TaskGrant;
      if (!isLocalGrant(parentGrant)) continue;
      const parentTarget = targets.get(parentGrant.agentId);
      if (
        isLocalGrant(grant)
          ? !parentTarget?.targets.includes(grant.agentId)
          : grant.sourceAgentId !== parentGrant.agentId
      )
        continue;
      if (
        grant.ancestorTaskIds.some((id, i) => {
          const ancestor = visible.get(id)?.grant as unknown as
            | TaskGrant
            | undefined;
          return (
            !ancestor ||
            !isLocalGrant(ancestor) ||
            ancestor.agentId !== grant.ancestorAgentIds[i]
          );
        })
      )
        continue;
    }
    if (isRemoteGrant(grant)) {
      try {
        const target = await remoteTarget(
          db,
          ctx.workspaceId,
          grant.sourceAgentId,
          grant.remoteAgentId,
        );
        if (target.binding !== grant.targetBinding) continue;
        visible.set(row.id, row);
        const task = Task.fromJSON(row.snapshot),
          status = jsonTask(task).status as { state?: string };
        const remote = task.metadata?.toolplaneRemote as
          | { state?: string; outcome?: "observed" | "unknown" }
          | undefined;
        nodes.push({
          id: row.id,
          parentTaskId: row.parentTaskId,
          agentId: grant.remoteAgentId,
          name: target.name,
          state: status?.state ?? "TASK_STATE_UNSPECIFIED",
          phase: row.phase,
          cancelRequested: Boolean(row.cancelRequestedAt),
          authorizedReservation: await collaborationReservation(db, grant),
          remoteState: remote?.state,
          remoteOutcome:
            remote?.outcome ??
            (row.remoteDispatchedAt && row.state === 4 ? "unknown" : undefined),
          resumeCount: row.resumeCount,
          updatedAt: row.statusAt.toISOString(),
        });
      } catch {
        /* Revoked remote targets are not readable through a guessed child ID. */
      }
      continue;
    }
    let target = targets.get(grant.agentId);
    if (!target) {
      try {
        target =
          row.executionBackend === "omp"
            ? await retainedOmpTarget(grant)
            : await localTarget(
                db,
                ctx.workspaceId,
                grant.agentId,
                row.id === root.id && grant.ancestorTaskIds.length === 0
                  ? grant.entryPolicy
                  : "delegation",
              );
        targets.set(grant.agentId, target);
      } catch {
        continue;
      }
    }
    // Historical execution expiry is not a read credential. Current actor/edge/config still governs access.
    if (target.binding !== grant.targetBinding) continue;
    visible.set(row.id, row);
    const task = Task.fromJSON(row.snapshot);
    const status = jsonTask(task).status as { state?: string } | undefined;
    const pendingUiRequests = nativeUiView(
      row.uiProjection,
      row.leaseToken,
      row.phase === "executing" &&
        !row.cancelRequestedAt &&
        row.deadlineAt > new Date(),
    ).uiRequests.length;
    nodes.push({
      id: row.id,
      parentTaskId: row.parentTaskId,
      agentId: grant.agentId,
      name: target.name,
      state: status?.state ?? "TASK_STATE_UNSPECIFIED",
      phase: row.phase,
      pendingUiRequests,
      ...(row.executionBackend === "pi-sdk" ||
      row.executionBackend === "omp" ||
      row.executionBackend === "pi-harness"
        ? {
            executionBackend: row.executionBackend,
            nativeOperationId: row.nativeOperationId,
            contextId: row.contextId,
          }
        : {}),
      cancelRequested: Boolean(row.cancelRequestedAt),
      authorizedReservation: await collaborationReservation(db, grant),
      resumeCount: row.resumeCount,
      updatedAt: row.statusAt.toISOString(),
    });
  }
  const selected = visible.get(selectedId);
  if (!visible.has(root.id) || !selected) throw new TaskNotFoundError();
  return {
    rootTaskId: root.id,
    nodes,
    restricted: visible.size !== rows.length,
    selectedTask: jsonTask(
      historyView(Task.fromJSON(selected.snapshot), historyLength),
    ),
  };
}

/** Retained entry ownership survives revision changes, not deletion or retargeting. */
async function assertRetainedEntrySource(grant: LocalA2AGrant) {
  const entry = grant.entryPolicy;
  if (!entry) return;
  if (entry.sourceAgentId !== grant.agentId) throw new TaskNotFoundError();
  if (entry.kind === "work") {
    if (
      !(await db.workSession.count({
        where: {
          id: entry.sourceId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
        },
      }))
    )
      throw new TaskNotFoundError();
    return;
  }
  if (
    entry.kind === "trigger" &&
    !(await db.agentTrigger.count({
      where: {
        id: entry.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
      },
    }))
  )
    throw new TaskNotFoundError();
  const conversationId =
    entry.kind === "trigger" ? entry.conversationId : entry.sourceId;
  if (
    !conversationId ||
    !(await db.conversation.count({
      where: {
        id: conversationId,
        agentId: grant.agentId,
        agent: { workspaceId: grant.workspaceId },
      },
    }))
  )
    throw new TaskNotFoundError();
  if (
    entry.kind === "channel" &&
    (!entry.channelId ||
      !(await db.agentChannelConnection.count({
        where: {
          id: entry.channelId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
        },
      })))
  )
    throw new TaskNotFoundError();
}

/** Workspace observation uses stored provenance, never current execution capabilities. */
export async function getConsoleTaskTree(
  ctx: ConsoleActor,
  rootId: string,
  selectedId = rootId,
  historyLength = 0,
): Promise<ConsoleTaskTree> {
  if (
    !Number.isSafeInteger(historyLength) ||
    historyLength < 0 ||
    historyLength > 32
  )
    throw new UnsupportedOperationError("Invalid history length.");
  await assertLocalActor(db, ctx.workspaceId, ctx.actorId);
  const root = await db.a2ATask.findFirst({
    where: {
      id: rootId,
      parentTaskId: null,
      context: {
        workspaceId: ctx.workspaceId,
        expiresAt: { gt: new Date() },
        OR: [
          { targetKind: "local", agentId: ctx.agentId },
          {
            targetKind: "published",
            endpoint: {
              workspaceId: ctx.workspaceId,
              sourceAgentId: ctx.agentId,
            },
          },
        ],
      },
    },
  });
  if (!root || (root.rootTaskId !== root.id && root.rootTaskId !== null))
    throw new TaskNotFoundError();
  const rows = await db.a2ATask.findMany({
    where: {
      OR: [{ id: root.id }, { rootTaskId: root.id }],
      context: { workspaceId: ctx.workspaceId, expiresAt: { gt: new Date() } },
    },
    include: {
      context: {
        include: {
          agent: { select: { id: true, workspaceId: true, name: true } },
          remoteAgent: { select: { id: true, workspaceId: true, name: true } },
          endpoint: {
            select: { workspaceId: true, sourceAgentId: true, name: true },
          },
        },
      },
    },
    orderBy: [{ depth: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: LOCAL_LIMITS.tasksPerRoot + 1,
  });
  if (rows.length > LOCAL_LIMITS.tasksPerRoot)
    throw new UnsupportedOperationError(
      "Task tree exceeds its configured limit.",
    );
  const visible = new Map<string, (typeof rows)[number]>();
  const nodes: ConsoleTaskTree["nodes"] = [];
  for (const row of rows) {
    const grant = row.grant as unknown as TaskGrant;
    const context = row.context;
    if (
      !grant ||
      grant.workspaceId !== ctx.workspaceId ||
      grant.ownerKey !== context.ownerKey
    )
      continue;
    // Entry contexts advance their revision/binding during explicit session upgrades;
    // retained task grants keep the original pin, which is not a read credential.
    const target = isLocalGrant(grant)
      ? context.targetKind === "local" && context.agentId === grant.agentId
        ? context.agent
        : null
      : isRemoteGrant(grant)
        ? context.targetKind === "remote" &&
          context.remoteAgentId === grant.remoteAgentId
          ? context.remoteAgent
          : null
        : context.targetKind === "published" &&
            context.endpointId === grant.endpointId &&
            context.clientId === grant.clientId
          ? context.endpoint
          : null;
    if (!target || target.workspaceId !== ctx.workspaceId) continue;
    if (row.id === root.id) {
      if (
        row.depth !== 0 ||
        isRemoteGrant(grant) ||
        (isLocalGrant(grant) &&
          (row.rootTaskId !== row.id ||
            grant.agentId !== ctx.agentId ||
            grant.ancestorTaskIds.length ||
            grant.ancestorAgentIds.length))
      )
        continue;
    } else {
      if (!isWorkspaceGrant(grant)) continue;
      const parent = row.parentTaskId
        ? visible.get(row.parentTaskId)
        : undefined;
      const parentGrant = parent?.grant as unknown as TaskGrant | undefined;
      if (
        !parent ||
        !parentGrant ||
        !isLocalGrant(parentGrant) ||
        grant.actorId !== parentGrant.actorId ||
        grant.rootTaskId !== root.id ||
        grant.parentTaskId !== parent.id ||
        row.depth !== parent.depth + 1 ||
        JSON.stringify(grant.ancestorTaskIds) !==
          JSON.stringify([...parentGrant.ancestorTaskIds, parent.id]) ||
        JSON.stringify(grant.ancestorAgentIds) !==
          JSON.stringify([
            ...parentGrant.ancestorAgentIds,
            parentGrant.agentId,
          ]) ||
        (isRemoteGrant(grant) && grant.sourceAgentId !== parentGrant.agentId)
      )
        continue;
    }
    visible.set(row.id, row);
    const task = Task.fromJSON(row.snapshot);
    const status = jsonTask(task).status as { state?: string } | undefined;
    const remote = task.metadata?.toolplaneRemote as
      | { state?: string; outcome?: "observed" | "unknown" }
      | undefined;
    nodes.push({
      id: row.id,
      parentTaskId: row.parentTaskId,
      agentId: isLocalGrant(grant)
        ? grant.agentId
        : isRemoteGrant(grant)
          ? grant.remoteAgentId
          : ctx.agentId,
      name: target.name,
      state: status?.state ?? "TASK_STATE_UNSPECIFIED",
      phase: row.phase,
      cancelRequested: Boolean(row.cancelRequestedAt),
      ...(isRemoteGrant(grant)
        ? {
            remoteState: remote?.state,
            remoteOutcome:
              remote?.outcome ??
              (row.remoteDispatchedAt && row.state === 4
                ? "unknown"
                : undefined),
          }
        : {
            pendingUiRequests: nativeUiView(
              row.uiProjection,
              row.leaseToken,
              row.phase === "executing" &&
                !row.cancelRequestedAt &&
                row.deadlineAt > new Date(),
            ).uiRequests.length,
          }),
      resumeCount: row.resumeCount,
      updatedAt: row.statusAt.toISOString(),
      ...(row.executionBackend === "pi-sdk" ||
      row.executionBackend === "omp" ||
      row.executionBackend === "pi-harness"
        ? {
            executionBackend: row.executionBackend,
            nativeOperationId: row.nativeOperationId,
            contextId: row.contextId,
          }
        : {}),
    });
  }
  const selected = visible.get(selectedId);
  if (!visible.has(root.id) || !selected) throw new TaskNotFoundError();
  if (selected.id === root.id) {
    const grant = selected.grant as unknown as TaskGrant;
    if (isLocalGrant(grant) && grant.entryPolicy) {
      if (grant.entryPolicy.kind !== "channel" && grant.actorId !== ctx.actorId)
        throw new TaskNotFoundError();
      await assertRetainedEntrySource(grant);
    }
  }
  return {
    rootTaskId: root.id,
    nodes,
    restricted: visible.size !== rows.length,
    selectedOutput: readTaskOutput(selected),
    selectedTask: jsonTask(
      historyView(Task.fromJSON(selected.snapshot), historyLength),
    ),
  };
}
