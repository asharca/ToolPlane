import "server-only";
import { createHash } from "node:crypto";
import { TaskState } from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  assertLocalActor,
  assertLocalGrant,
  LOCAL_LIMITS,
  localOwnerKey,
  localTarget,
} from "./local-policy";
import {
  A2A_SCOPES,
  isLocalGrant,
  type TaskGrant,
  type RemoteA2AGrant,
} from "./principal";
import { remotePair } from "./remote-network";
import { AgentCard } from "@a2a-js/sdk";
import {
  collaborationPolicy,
  CollaborationApprovalRequiredError,
} from "./collaboration-policy";
const missing = () => new TaskNotFoundError();
export async function remoteTarget(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  sourceAgentId: string,
  id: string,
  sourceTaskId?: string,
) {
  const policy = await collaborationPolicy(
    tx,
    workspaceId,
    sourceAgentId,
    "remote",
    id,
    sourceTaskId,
  );
  const row = await tx.remoteA2AAgent.findFirst({
    where: {
      id,
      workspaceId,
      enabled: true,
      allowedAgentIds: { has: sourceAgentId },
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      cardUrl: true,
      rpcUrl: true,
      revision: true,
      card: true,
    },
  });
  if (!row) throw missing();
  remotePair(row.cardUrl, row.rpcUrl);
  if (
    AgentCard.fromJSON(row.card).skills.some(
      (skill) => !policy.capabilityIds.includes(skill.id),
    )
  )
    throw new CollaborationApprovalRequiredError(
      "Remote capabilities exceed the approved policy.",
    );
  return {
    ...row,
    maxDepth: policy.maxDepth,
    binding: createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.workspaceId,
          row.revision,
          row.cardUrl,
          row.rpcUrl,
        ]),
      )
      .digest("hex"),
  };
}
export async function assertRemoteGrant(
  grant: RemoteA2AGrant,
  tx: Prisma.TransactionClient = db,
  cancellation = false,
) {
  if (
    !grant.parentTaskId ||
    !grant.rootTaskId ||
    grant.ancestorTaskIds.length !== grant.ancestorAgentIds.length ||
    !grant.ancestorTaskIds.length ||
    grant.ancestorTaskIds.length > LOCAL_LIMITS.depth ||
    grant.ancestorTaskIds.at(-1) !== grant.parentTaskId ||
    grant.ancestorAgentIds.at(-1) !== grant.sourceAgentId ||
    grant.ancestorTaskIds[0] !== grant.rootTaskId ||
    grant.expiresAt <= Date.now()
  )
    throw missing();
  await assertLocalActor(tx, grant.workspaceId, grant.actorId);
  const target = await remoteTarget(
    tx,
    grant.workspaceId,
    grant.sourceAgentId,
    grant.remoteAgentId,
    grant.parentTaskId,
  );
  if (
    target.binding !== grant.targetBinding ||
    (!cancellation && grant.ancestorTaskIds.length > target.maxDepth)
  )
    throw missing();
  const parent = await tx.a2ATask.findUnique({
    where: { id: grant.parentTaskId },
  });
  const authority = parent?.grant as unknown as TaskGrant | undefined;
  if (
    !parent ||
    !authority ||
    !isLocalGrant(authority) ||
    authority.workspaceId !== grant.workspaceId ||
    authority.actorId !== grant.actorId ||
    authority.agentId !== grant.sourceAgentId
  )
    throw missing();
  if (
    !(await tx.agent.count({
      where: {
        id: grant.sourceAgentId,
        workspaceId: grant.workspaceId,
        a2aOutboundEnabled: true,
      },
    }))
  )
    throw missing();
  if (
    JSON.stringify(grant.ancestorTaskIds) !==
      JSON.stringify([...authority.ancestorTaskIds, parent.id]) ||
    JSON.stringify(grant.ancestorAgentIds) !==
      JSON.stringify([...authority.ancestorAgentIds, authority.agentId]) ||
    grant.expiresAt > Math.min(authority.expiresAt, parent.deadlineAt.getTime())
  )
    throw missing();
  if (authority.entryPolicy)
    await (await import("./entry-policy")).assertEntryPolicy(tx, authority);
  if (cancellation) {
    // A stopped parent may still cancel a known remote task, but never authorize new work.
    if (
      (
        await localTarget(
          tx,
          grant.workspaceId,
          authority.agentId,
          authority.ancestorTaskIds.length
            ? "delegation"
            : authority.entryPolicy,
          authority.agentRevisionId,
        )
      ).binding !== authority.targetBinding
    )
      throw missing();
    return;
  }
  if (
    parent.cancelRequestedAt ||
    parent.deadlineAt <= new Date() ||
    [3, 4, 5, 7].includes(parent.state)
  )
    throw missing();
  await assertLocalGrant(authority, tx, grant.ancestorTaskIds.length);
}
export async function remoteChildGrant(
  parentId: string,
  lease: string,
  remoteId: string,
): Promise<RemoteA2AGrant> {
  const parent = await db.a2ATask.findUnique({ where: { id: parentId } });
  const caller = parent?.grant as unknown as TaskGrant | undefined;
  if (
    !parent ||
    !caller ||
    !isLocalGrant(caller) ||
    parent.state !== TaskState.TASK_STATE_WORKING ||
    parent.phase !== "executing" ||
    parent.leaseToken !== lease ||
    parent.cancelRequestedAt
  )
    throw missing();
  if (caller.ancestorTaskIds.length + 1 > LOCAL_LIMITS.depth)
    throw new UnsupportedOperationError(
      "Remote delegation depth limit reached.",
    );
  await assertLocalGrant(caller, db, caller.ancestorTaskIds.length + 1);
  const target = await remoteTarget(
    db,
    caller.workspaceId,
    caller.agentId,
    remoteId,
    parent.id,
  );
  const policy = await collaborationPolicy(
    db,
    caller.workspaceId,
    caller.agentId,
    "remote",
    remoteId,
    parent.id,
  );
  if (caller.ancestorTaskIds.length + 1 > policy.maxDepth)
    throw new CollaborationApprovalRequiredError(
      "Approved remote delegation depth exceeded.",
    );
  return {
    kind: "remote",
    workspaceId: caller.workspaceId,
    sourceAgentId: caller.agentId,
    remoteAgentId: remoteId,
    actorId: caller.actorId,
    targetBinding: target.binding,
    ownerKey: localOwnerKey(
      "remote",
      caller.workspaceId,
      parent.id,
      remoteId,
      caller.actorId,
    ),
    parentTaskId: parent.id,
    rootTaskId: parent.rootTaskId ?? parent.id,
    ancestorTaskIds: [...caller.ancestorTaskIds, parent.id],
    ancestorAgentIds: [...caller.ancestorAgentIds, caller.agentId],
    expiresAt: Math.min(caller.expiresAt, parent.deadlineAt.getTime()),
    timeoutSeconds: Math.min(caller.timeoutSeconds, policy.timeoutSeconds),
    retentionDays: 7,
    maxConcurrent: Math.min(caller.maxConcurrent, policy.maxConcurrent),
    scopes: caller.scopes.filter((scope) =>
      A2A_SCOPES.some((allowed) => allowed === scope),
    ),
  };
}
