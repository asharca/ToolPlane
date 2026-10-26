import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { TaskState } from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import {
  A2A_SCOPES,
  isLocalGrant,
  type LocalA2AGrant,
  type TaskGrant,
} from "./principal";
import {
  collaborationPolicy,
  CollaborationApprovalRequiredError,
} from "./collaboration-policy";

export const LOCAL_LIMITS = {
  depth: 3,
  tasksPerRoot: 16,
  resumes: 16,
  queuedPerWorkspace: 16,
  tasksPerOwner: 256,
  requestBytes: 65_536,
} as const;
type Database = Prisma.TransactionClient;
const missing = () => new TaskNotFoundError();
export function localOwnerKey(...values: string[]) {
  return createHash("sha256")
    .update(JSON.stringify(["toolplane:a2a:local:v1", ...values]))
    .digest("hex");
}
export function localEntryOwnerKey(
  workspaceId: string,
  agentId: string,
  actorId: string,
  entry: NonNullable<LocalA2AGrant["entryPolicy"]>,
) {
  return localOwnerKey(
    "entry",
    workspaceId,
    agentId,
    actorId,
    entry.kind,
    entry.sourceId,
  );
}
export async function assertLocalActor(
  tx: Database,
  workspaceId: string,
  actorId: string,
) {
  if (
    !(await tx.workspace.count({
      where: {
        id: workspaceId,
        status: "active",
        owner: { status: "active" },
        OR: [
          { ownerId: actorId },
          {
            members: { some: { userId: actorId, user: { status: "active" } } },
          },
        ],
      },
    })) ||
    !(await tx.user.count({ where: { id: actorId, status: "active" } }))
  )
    throw missing();
}
/** Hash configured capabilities; delegation callers must separately authorize the parent-child edge. */
export async function localTarget(
  tx: Database,
  workspaceId: string,
  agentId: string,
  entry?: LocalA2AGrant["entryPolicy"] | "delegation",
  revisionId?: string,
) {
  if (entry && entry !== "delegation" && entry.sourceAgentId !== agentId)
    throw missing();
  const agent = await tx.agent.findFirst({
    where: {
      ...ORDINARY_AGENT_FILTER,
      id: agentId,
      workspaceId,
      ...(!entry || entry === "delegation" || entry.kind === "channel"
        ? { a2aInboundEnabled: true }
        : {}),
    },
    select: {
      id: true,
      name: true,
      runtimeKind: true,
      a2aInboundEnabled: true,
      a2aOutboundEnabled: true,
      providerId: true,
      sandboxes: {
        select: {
          sandboxId: true,
          sandbox: {
            select: {
              workspaceId: true,
              kind: true,
              network: true,
            },
          },
        },
      },
      skills: {
        orderBy: { installedSkillId: "asc" },
        select: { installedSkillId: true },
      },
      subAgents: { orderBy: { childId: "asc" }, select: { childId: true } },
    },
  });
  if (
    agent?.runtimeKind !== "pi-sdk" ||
    agent.sandboxes.length !== 1 ||
    agent.sandboxes[0].sandbox.workspaceId !== workspaceId ||
    agent.sandboxes[0].sandbox.kind !== "docker" ||
    agent.sandboxes[0].sandbox.network === "none"
  )
    throw missing();
  const revision = await requireAgentRevision(tx, agentId, revisionId);
  const config = revision.config;
  if (
    (!entry || entry === "delegation" || entry.kind === "channel") &&
    !config.a2a.inboundEnabled
  )
    throw missing();
  const sandbox = agent.sandboxes[0];
  if (
    sandbox.sandboxId !== config.sandboxTemplateId ||
    !config.providerId ||
    !config.model ||
    agent.providerId !== config.providerId
  )
    throw missing();
  const skills = config.skills
    .filter((skill) =>
      agent.skills.some(
        (link) => link.installedSkillId === skill.installedSkillId,
      ),
    )
    .map((skill) => skill.installedSkillId);
  const binding = createHash("sha256")
    .update(JSON.stringify([agent.id, revision.id]))
    .digest("hex");
  return {
    id: agent.id,
    name: agent.name,
    binding,
    agentRevisionId: revision.id,
    sandboxId: agent.sandboxes[0].sandboxId,
    providerId: config.providerId,
    targets:
      config.a2a.outboundEnabled && agent.a2aOutboundEnabled
        ? config.a2a.policy.targets
            .filter((target) => target.kind === "local")
            .map((target) => target.targetId)
            .filter((id) => agent.subAgents.some((link) => link.childId === id))
        : [],
    capabilityIds: skills,
  };
}
/** Recheck ancestor policies against final depth, including any remote leaf. */
export async function assertLocalGrant(
  grant: LocalA2AGrant,
  tx: Database = db,
  delegationDepth = grant.ancestorTaskIds.length,
) {
  if (
    grant.expiresAt <= Date.now() ||
    !Number.isSafeInteger(delegationDepth) ||
    delegationDepth < grant.ancestorTaskIds.length ||
    delegationDepth > LOCAL_LIMITS.depth ||
    grant.ancestorTaskIds.length !== grant.ancestorAgentIds.length
  )
    throw missing();
  if (
    grant.entryPolicy &&
    grant.ancestorTaskIds.length === 0 &&
    grant.ownerKey !==
      localEntryOwnerKey(
        grant.workspaceId,
        grant.agentId,
        grant.actorId,
        grant.entryPolicy,
      ) &&
    grant.ownerKey !==
      localOwnerKey(grant.workspaceId, grant.agentId, grant.actorId)
  )
    throw missing();
  await assertLocalActor(tx, grant.workspaceId, grant.actorId);
  if (!grant.agentRevisionId) throw missing();
  if (grant.entryPolicy)
    await (await import("./entry-policy")).assertEntryPolicy(tx, grant);
  const entry =
    grant.ancestorTaskIds.length === 0 ? grant.entryPolicy : "delegation";
  if (
    (
      await localTarget(
        tx,
        grant.workspaceId,
        grant.agentId,
        entry,
        grant.agentRevisionId,
      )
    ).binding !== grant.targetBinding
  )
    throw missing();
  for (let index = 0; index < grant.ancestorTaskIds.length; index++) {
    const ancestor = await tx.a2ATask.findUnique({
      where: { id: grant.ancestorTaskIds[index] },
    });
    if (
      !ancestor ||
      ancestor.cancelRequestedAt ||
      ancestor.deadlineAt <= new Date() ||
      [
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_REJECTED,
        TaskState.TASK_STATE_CANCELED,
      ].includes(ancestor.state)
    )
      throw missing();
    const authority = ancestor.grant as unknown as TaskGrant;
    if (
      !isLocalGrant(authority) ||
      authority.workspaceId !== grant.workspaceId ||
      authority.actorId !== grant.actorId ||
      authority.agentId !== grant.ancestorAgentIds[index]
    )
      throw missing();
    const current = await localTarget(
      tx,
      grant.workspaceId,
      authority.agentId,
      authority.ancestorTaskIds.length === 0
        ? authority.entryPolicy
        : "delegation",
      authority.agentRevisionId,
    );
    const next = grant.ancestorAgentIds[index + 1] ?? grant.agentId;
    const policy = await collaborationPolicy(
      tx,
      grant.workspaceId,
      authority.agentId,
      "local",
      next,
      ancestor.id,
    );
    if (delegationDepth > policy.maxDepth) throw missing();
    if (
      current.binding !== authority.targetBinding ||
      !current.targets.includes(next)
    )
      throw missing();
  }
}
export async function createLocalRootGrant(
  workspaceId: string,
  agentId: string,
  actorId: string,
): Promise<LocalA2AGrant> {
  await assertLocalActor(db, workspaceId, actorId);
  const target = await localTarget(db, workspaceId, agentId);
  return {
    kind: "local",
    workspaceId,
    agentId,
    actorId,
    agentRevisionId: target.agentRevisionId,
    targetBinding: target.binding,
    ownerKey: localOwnerKey(workspaceId, agentId, actorId),
    expiresAt: Date.now() + 840_000,
    scopes: [...A2A_SCOPES],
    maxConcurrent: 4,
    timeoutSeconds: 840,
    retentionDays: 7,
    ancestorTaskIds: [],
    ancestorAgentIds: [],
  };
}
/** Ordinary ingress is bound to its live source, not the A2A opt-in switch. */
export async function createLocalEntryGrant(
  tx: Database,
  workspaceId: string,
  agentId: string,
  actorId: string,
  entry: NonNullable<LocalA2AGrant["entryPolicy"]>,
): Promise<LocalA2AGrant> {
  await assertLocalActor(tx, workspaceId, actorId);
  const owner =
    entry.kind === "work"
      ? await tx.workSession.findFirst({
          where: { id: entry.sourceId, agentId, workspaceId },
          select: { agentRevisionId: true, legacyRevisionUnresolved: true },
        })
      : await tx.conversation.findFirst({
          where: { id: entry.sourceId, agentId, agent: { workspaceId } },
          select: { agentRevisionId: true, legacyRevisionUnresolved: true },
        });
  if (!owner?.agentRevisionId || owner.legacyRevisionUnresolved)
    throw missing();
  const target = await localTarget(
    tx,
    workspaceId,
    agentId,
    entry,
    owner.agentRevisionId,
  );
  return {
    kind: "local",
    workspaceId,
    agentId,
    actorId,
    agentRevisionId: target.agentRevisionId,
    entryPolicy: entry,
    targetBinding: target.binding,
    ownerKey: localEntryOwnerKey(workspaceId, agentId, actorId, entry),
    expiresAt: Date.now() + 840_000,
    scopes: [...A2A_SCOPES],
    maxConcurrent: 4,
    timeoutSeconds: 840,
    retentionDays: 7,
    ancestorTaskIds: [],
    ancestorAgentIds: [],
  };
}
export async function childGrant(
  parentId: string,
  lease: string,
  targetId: string,
): Promise<LocalA2AGrant> {
  const parent = await db.a2ATask.findUnique({ where: { id: parentId } });
  if (
    !parent ||
    parent.state !== TaskState.TASK_STATE_WORKING ||
    parent.phase !== "executing" ||
    parent.leaseToken !== lease ||
    parent.cancelRequestedAt
  )
    throw missing();
  const authority = parent.grant as unknown as TaskGrant;
  if (!isLocalGrant(authority)) throw missing();
  await assertLocalGrant(authority);
  const chain = [...authority.ancestorAgentIds, authority.agentId];
  if (chain.includes(targetId) || chain.length > LOCAL_LIMITS.depth)
    throw new UnsupportedOperationError("Delegation cycle or depth limit.");
  const caller = await localTarget(
    db,
    authority.workspaceId,
    authority.agentId,
    authority.ancestorTaskIds.length === 0
      ? authority.entryPolicy
      : "delegation",
    authority.agentRevisionId,
  );
  if (!caller.targets.includes(targetId)) throw missing();
  const policy = await collaborationPolicy(
    db,
    authority.workspaceId,
    authority.agentId,
    "local",
    targetId,
    parent.id,
  );
  if (chain.length > policy.maxDepth)
    throw new CollaborationApprovalRequiredError(
      "Approved delegation depth exceeded.",
    );
  const target = await localTarget(
    db,
    authority.workspaceId,
    targetId,
    "delegation",
  );
  const capabilities = [...new Set(target.capabilityIds)];
  if (capabilities.some((id) => !policy.capabilityIds.includes(id)))
    throw new CollaborationApprovalRequiredError(
      "Target capabilities exceed the approved policy.",
    );
  return {
    ...authority,
    agentId: targetId,
    agentRevisionId: target.agentRevisionId,
    timeoutSeconds: Math.min(authority.timeoutSeconds, policy.timeoutSeconds),
    maxConcurrent: Math.min(authority.maxConcurrent, policy.maxConcurrent),
    targetBinding: target.binding,
    parentTaskId: parentId,
    rootTaskId: parent.rootTaskId ?? parent.id,
    ancestorTaskIds: [...authority.ancestorTaskIds, parent.id],
    ancestorAgentIds: chain,
    ownerKey: localOwnerKey(
      authority.workspaceId,
      parent.id,
      targetId,
      authority.actorId,
    ),
    expiresAt: Math.min(authority.expiresAt, parent.deadlineAt.getTime()),
  };
}
