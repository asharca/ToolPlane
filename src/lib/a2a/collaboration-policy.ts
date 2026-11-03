import "server-only";
import type { Prisma } from "@prisma/client";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { AgentA2APolicySchema } from "@/lib/agents/revision-types";
import type { AgentA2APolicy } from "@/lib/agents/revision-types";
import { requireAgentRevision } from "@/lib/agents/revisions";
import type { LocalA2AGrant, RemoteA2AGrant } from "./principal";

export class CollaborationApprovalRequiredError extends UnsupportedOperationError {}

type TargetPolicy = AgentA2APolicy["targets"][number];
export function intersectCollaborationPolicy(
  pinned: TargetPolicy,
  live: TargetPolicy,
): TargetPolicy {
  if (
    pinned.kind !== live.kind ||
    pinned.targetId !== live.targetId ||
    (pinned.budget &&
      live.budget &&
      pinned.budget.currency !== live.budget.currency)
  )
    throw new CollaborationApprovalRequiredError(
      "Collaboration policy identity changed.",
    );
  const budget =
    pinned.budget && live.budget
      ? {
          currency: pinned.budget.currency,
          maxAuthorizedCostMicros: Math.min(
            pinned.budget.maxAuthorizedCostMicros,
            live.budget.maxAuthorizedCostMicros,
          ),
          authorizedCostPerCallMicros: Math.max(
            pinned.budget.authorizedCostPerCallMicros,
            live.budget.authorizedCostPerCallMicros,
          ),
        }
      : (pinned.budget ?? live.budget);
  return {
    ...pinned,
    capabilityIds: pinned.capabilityIds.filter((id) =>
      live.capabilityIds.includes(id),
    ),
    maxCalls: Math.min(pinned.maxCalls, live.maxCalls),
    maxDepth: Math.min(pinned.maxDepth, live.maxDepth),
    maxConcurrent: Math.min(pinned.maxConcurrent, live.maxConcurrent),
    timeoutSeconds: Math.min(pinned.timeoutSeconds, live.timeoutSeconds),
    maxInputBytes: Math.min(pinned.maxInputBytes, live.maxInputBytes),
    ...(budget ? { budget } : {}),
  };
}

/** Live policy is an additional restriction, never authority inherited from a parent. */
export async function collaborationPolicy(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  sourceAgentId: string,
  kind: "local" | "remote",
  targetId: string,
  sourceTaskId?: string,
) {
  const source = await tx.agent.findFirst({
    where: { id: sourceAgentId, workspaceId, a2aOutboundEnabled: true },
    select: { a2aPolicy: true },
  });
  const parsed = AgentA2APolicySchema.safeParse(source?.a2aPolicy);
  const matches = parsed.success
    ? parsed.data.targets.filter(
        (target) => target.kind === kind && target.targetId === targetId,
      )
    : [];
  const policy = matches[0];
  if (matches.length !== 1 || !policy)
    throw new CollaborationApprovalRequiredError(
      "A2A collaboration is outside the approved policy; administrator approval is required.",
    );
  const context = sourceTaskId
    ? await tx.a2ATask.findFirst({
        where: {
          id: sourceTaskId,
          context: { workspaceId, agentId: sourceAgentId, targetKind: "local" },
        },
        select: {
          context: {
            select: { agentRevisionId: true, legacyRevisionUnresolved: true },
          },
        },
      })
    : null;
  if (
    sourceTaskId &&
    (!context?.context.agentRevisionId ||
      context.context.legacyRevisionUnresolved)
  )
    throw new CollaborationApprovalRequiredError(
      "Historical collaboration is read-only.",
    );
  const revision = await requireAgentRevision(
    tx,
    sourceAgentId,
    context?.context.agentRevisionId ?? undefined,
  );
  const approved = revision.config.a2a.outboundEnabled
    ? revision.config.a2a.policy.targets.filter(
        (target) => target.kind === kind && target.targetId === targetId,
      )
    : [];
  if (approved.length !== 1 || !approved[0])
    throw new CollaborationApprovalRequiredError(
      "Collaboration exceeds the pinned revision; start a new task after approval.",
    );
  return intersectCollaborationPolicy(approved[0], policy);
}

/** Called under the workspace admission lock, after idempotent receipt lookup. */
export async function assertCollaborationAdmission(
  tx: Prisma.TransactionClient,
  grant: LocalA2AGrant | RemoteA2AGrant,
  inputBytes: number,
  continuation: boolean,
) {
  if (!grant.parentTaskId || !grant.rootTaskId) return;
  const remote = grant.kind === "remote";
  const sourceId = remote ? grant.sourceAgentId : grant.ancestorAgentIds.at(-1);
  if (!sourceId)
    throw new UnsupportedOperationError("Missing collaboration source.");
  const policy = await collaborationPolicy(
    tx,
    grant.workspaceId,
    sourceId,
    remote ? "remote" : "local",
    remote ? grant.remoteAgentId : grant.agentId,
    grant.parentTaskId,
  );
  if (
    inputBytes > policy.maxInputBytes ||
    grant.ancestorTaskIds.length > policy.maxDepth
  )
    throw new CollaborationApprovalRequiredError(
      "A2A input or depth exceeds the approved policy.",
    );
  const where = {
    rootTaskId: grant.rootTaskId,
    context: {
      workspaceId: grant.workspaceId,
      ...(remote
        ? { remoteAgentId: grant.remoteAgentId }
        : { agentId: grant.agentId }),
    },
  };
  const [calls, active] = await Promise.all([
    tx.a2ARequest.count({ where: { task: where } }),
    tx.a2ATask.count({ where: { ...where, state: { in: [1, 2, 6, 8] } } }),
  ]);
  if (
    calls >= policy.maxCalls ||
    (!continuation && active >= policy.maxConcurrent)
  )
    throw new CollaborationApprovalRequiredError(
      "A2A call or concurrency budget exhausted.",
    );
  if (
    policy.budget &&
    BigInt(calls + 1) * BigInt(policy.budget.authorizedCostPerCallMicros) >
      BigInt(policy.budget.maxAuthorizedCostMicros)
  )
    throw new CollaborationApprovalRequiredError(
      "A2A authorized cost reservation budget exhausted; this is not measured billing.",
    );
}

export async function collaborationReservation(
  tx: Prisma.TransactionClient,
  grant: LocalA2AGrant | RemoteA2AGrant,
) {
  if (!grant.rootTaskId || !grant.parentTaskId) return undefined;
  const remote = grant.kind === "remote";
  const sourceId = remote ? grant.sourceAgentId : grant.ancestorAgentIds.at(-1);
  if (!sourceId) return undefined;
  const policy = await collaborationPolicy(
    tx,
    grant.workspaceId,
    sourceId,
    remote ? "remote" : "local",
    remote ? grant.remoteAgentId : grant.agentId,
    grant.parentTaskId,
  );
  if (!policy.budget) return undefined;
  const calls = await tx.a2ARequest.count({
    where: {
      task: {
        rootTaskId: grant.rootTaskId,
        context: {
          workspaceId: grant.workspaceId,
          ...(remote
            ? { remoteAgentId: grant.remoteAgentId }
            : { agentId: grant.agentId }),
        },
      },
    },
  });
  return {
    currency: policy.budget.currency,
    reservedMicros: Number(
      BigInt(calls) * BigInt(policy.budget.authorizedCostPerCallMicros),
    ),
    limitMicros: policy.budget.maxAuthorizedCostMicros,
  };
}
