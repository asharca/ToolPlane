import "server-only";
import type { Prisma } from "@prisma/client";
import {
  AgentA2APolicySchema,
  type AgentRevisionConfig,
} from "@/lib/agents/revision-types";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { localTarget } from "@/lib/a2a/local-policy";
import type { ComposerItem, ComposerReference } from "./composer-types";

export class AgentReferenceError extends Error {
  readonly status = 400;
  readonly code = "WORK_AGENT_REFERENCE_FORBIDDEN";

  constructor() {
    super("WORK_AGENT_REFERENCE_FORBIDDEN");
    this.name = "AgentReferenceError";
  }
}

type Scope = {
  workspaceId: string;
  agentId: string;
  agentRevisionId: string;
};
type Target = ComposerItem & { kind: "agent"; targetKind: "local" | "remote" };

/** A mention observes pinned authority intersected with live revocation, never grants it. */
export async function listAgentReferenceTargets(
  tx: Prisma.TransactionClient,
  scope: Scope,
  config: AgentRevisionConfig,
  query = "",
): Promise<Target[]> {
  if (!config.a2a.outboundEnabled) return [];
  const source = await tx.agent.findFirst({
    where: { id: scope.agentId, workspaceId: scope.workspaceId },
    select: { a2aOutboundEnabled: true, a2aPolicy: true },
  });
  const live = AgentA2APolicySchema.safeParse(source?.a2aPolicy);
  if (!source?.a2aOutboundEnabled || !live.success) return [];
  const liveTargets = new Set(
    live.data.targets.map((target) => `${target.kind}:${target.targetId}`),
  );
  const targets = config.a2a.policy.targets.filter((target) =>
    liveTargets.has(`${target.kind}:${target.targetId}`),
  );
  const delegationTarget = async (agentId: string, revisionId?: string) => {
    try {
      return await localTarget(
        tx,
        scope.workspaceId,
        agentId,
        "delegation",
        revisionId,
      );
    } catch (error) {
      if (
        error instanceof TaskNotFoundError ||
        error instanceof AgentRevisionError
      )
        return null;
      throw error;
    }
  };
  const localTargets = async () => {
    const candidates = targets.filter(
      (target) => target.kind === "local" && target.targetId !== scope.agentId,
    );
    if (!candidates.length) return [];
    const parent = await delegationTarget(scope.agentId, scope.agentRevisionId);
    if (!parent) return [];
    const resolved = await Promise.all(
      candidates
        .filter((target) => parent.targets.includes(target.targetId))
        .map((target) => delegationTarget(target.targetId)),
    );
    const needle = query.toLowerCase();
    return resolved
      .filter((target) => target !== null)
      .filter((target) => target.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  const [local, remote] = await Promise.all([
    localTargets(),
    tx.remoteA2AAgent.findMany({
      where: {
        workspaceId: scope.workspaceId,
        id: {
          in: targets
            .filter((target) => target.kind === "remote")
            .map((target) => target.targetId),
        },
        enabled: true,
        allowedAgentIds: { has: scope.agentId },
        ...(query
          ? { name: { contains: query, mode: "insensitive" as const } }
          : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  return [
    ...local.map(
      ({ id, name }): Target => ({
        kind: "agent",
        targetKind: "local",
        id,
        label: name.slice(0, 1000),
      }),
    ),
    ...remote.map(
      ({ id, name }): Target => ({
        kind: "agent",
        targetKind: "remote",
        id,
        label: name.slice(0, 1000),
      }),
    ),
  ];
}

export function agentTargetReference(target: Target): ComposerReference {
  const destination = `${target.targetKind === "local" ? "agent" : "remote"}:${target.id}`;
  const operation =
    target.targetKind === "local"
      ? "a2a_send_message"
      : "a2a_send_remote_message";
  return {
    kind: "agent",
    id: target.id,
    targetKind: target.targetKind,
    label: target.label,
    text: `Agent delegation reference: ${JSON.stringify(target.label)}. Delegate the relevant work from the user's request to this target using pi_a2a_submit with target=${JSON.stringify(destination)} (the platform ${operation} operation). Provide the task as message and a unique messageId. Observe the delegated result before treating the work as complete. This reference grants no additional permissions; all existing A2A authorization, approval and resource limits still apply.`,
  };
}

/** Rebuild model instructions on submission: client labels and text are not authority. */
export async function resolveSubmittedAgentReferences(
  tx: Prisma.TransactionClient,
  scope: Scope,
  config: AgentRevisionConfig,
  references: ComposerReference[] = [],
): Promise<ComposerReference[]> {
  if (!references.some((reference) => reference.kind === "agent"))
    return references;
  const targets = await listAgentReferenceTargets(tx, scope, config);
  return references.map((reference) => {
    if (reference.kind !== "agent") return reference;
    const target = targets.find(
      (target) =>
        target.id === reference.id &&
        target.targetKind === reference.targetKind,
    );
    if (!target) throw new AgentReferenceError();
    return agentTargetReference(target);
  });
}
