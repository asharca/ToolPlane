import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import {
  localTarget,
  localTargetReason,
  LOCAL_LIMITS,
} from "@/lib/a2a/local-policy";
import { PluginError, requirePluginWorkspace } from "@/lib/plugins/catalog";
import { AgentRevisionError } from "./revisions";
import {
  AgentA2APolicySchema,
  NativeSubagentPolicySchema,
} from "./revision-types";
import { isExecutableAgentRuntimeKind } from "./runtime-kind";

/** Platform Agent delegation is explicitly reviewed; retired native tasks grant no authority. */
export const SubagentSettingsSchema = z
  .object({
    native: z.boolean(),
    agentIds: z.array(z.string().min(1).max(240)).max(128),
    nativePolicy: NativeSubagentPolicySchema,
  })
  .strict();

function settings(
  parent: {
    subagentMode: string;
    nativeSubagentMaxConcurrency: number;
    nativeSubagentMaxDepth: number;
  },
  agents: unknown[],
) {
  return {
    native: parent.subagentMode === "native",
    nativePolicy: {
      maxConcurrency: parent.nativeSubagentMaxConcurrency,
      maxDepth: parent.nativeSubagentMaxDepth,
    },
    agents,
  };
}

function reachesParent(
  edges: { parentId: string; childId: string }[],
  parentId: string,
  childId: string,
) {
  const pending = [childId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    if (id === parentId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges)
      if (edge.parentId === id && edge.parentId !== parentId)
        pending.push(edge.childId);
  }
  return false;
}

async function platformChildren(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) {
  const parent = await tx.agent.findFirst({
    where: { id: agentId, workspaceId, retiredAt: null },
    include: { subAgents: true },
  });
  if (!parent || !isExecutableAgentRuntimeKind(parent.runtimeKind))
    throw new PluginError("not_found", "Agent unavailable.", 404);
  const agents = await tx.agent.findMany({
    where: { workspaceId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      runtimeKind: true,
      retiredAt: true,
      currentRevisionVersion: true,
      skills: { select: { installedSkillId: true } },
    },
  });
  const edges = await tx.agentSubAgent.findMany({
    where: { parent: { workspaceId }, child: { workspaceId } },
    select: { parentId: true, childId: true },
  });
  const options = [];
  const capabilities = new Map<string, string[]>();
  for (const agent of agents) {
    let reason: string | undefined;
    let disabled = false;
    const checked = parent.subAgents.some((edge) => edge.childId === agent.id);
    capabilities.set(
      agent.id,
      agent.skills.map((skill) => skill.installedSkillId),
    );
    if (agent.id === agentId) {
      reason = "SUBAGENT_SELF";
      disabled = true;
    } else if (
      agent.retiredAt ||
      !isExecutableAgentRuntimeKind(agent.runtimeKind)
    ) {
      reason = "SUBAGENT_RUNTIME_UNAVAILABLE";
      disabled = true;
    } else if (reachesParent(edges, agentId, agent.id)) {
      reason = "SUBAGENT_CYCLE";
      disabled = true;
    } else {
      // Unready children cannot be newly selected; existing edges may be kept or removed.
      try {
        if (!agent.currentRevisionVersion)
          throw new AgentRevisionError("AGENT_REVISION_REQUIRED");
        capabilities.set(
          agent.id,
          (await localTarget(tx, workspaceId, agent.id, "delegation"))
            .capabilityIds,
        );
      } catch (error) {
        if (
          !(error instanceof TaskNotFoundError) &&
          !(error instanceof AgentRevisionError)
        )
          throw error;
        reason = localTargetReason(error) ?? "SUBAGENT_REVISION_UNAVAILABLE";
        disabled = !checked;
      }
    }
    options.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      checked,
      ...(reason ? { disabled, reason } : {}),
    });
  }
  return { parent, options, capabilities };
}

export async function listPlatformSubagents(
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  await requirePluginWorkspace(workspaceId, userId);
  const { parent, options } = await platformChildren(db, workspaceId, agentId);
  return settings(parent, options);
}

/** Selection is a draft; the parent's reviewed edge authorizes delegation to each child. */
export async function savePlatformSubagents(
  workspaceId: string,
  userId: string,
  agentId: string,
  value: z.infer<typeof SubagentSettingsSchema>,
) {
  const { native, agentIds, nativePolicy } =
    SubagentSettingsSchema.parse(value);
  return db.$transaction(async (tx) => {
    await requirePluginWorkspace(workspaceId, userId, true, tx);
    // Serialize graph changes so concurrent inverse edges cannot both pass cycle validation.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${agentId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
    const { parent, options, capabilities } = await platformChildren(
      tx,
      workspaceId,
      agentId,
    );
    if (native)
      throw new PluginError(
        "SUBAGENT_NATIVE_OMP_REQUIRED",
        "Native OMP subagents are retired.",
      );
    if (new Set(agentIds).size !== agentIds.length)
      throw new PluginError("SUBAGENT_INVALID", "Duplicate platform Agent.");
    for (const id of agentIds) {
      const option = options.find((candidate) => candidate.id === id);
      if (!option || option.disabled)
        throw new PluginError(
          option?.reason ?? "SUBAGENT_FORBIDDEN",
          "Platform Agent unavailable for delegation.",
          403,
        );
    }
    const policy = AgentA2APolicySchema.parse(
      parent.a2aPolicy ?? { schemaVersion: 1, targets: [] },
    );
    const local = agentIds.map((targetId) => {
      const existing = policy.targets.find(
        (target) => target.kind === "local" && target.targetId === targetId,
      );
      const capabilityIds = capabilities.get(targetId);
      if (!capabilityIds)
        throw new PluginError(
          "SUBAGENT_FORBIDDEN",
          "Platform Agent capabilities unavailable.",
          403,
        );
      // Preserve reviewed restrictions on retained targets; explicit new selections get bounded grants.
      return (
        existing ?? {
          kind: "local" as const,
          targetId,
          capabilityIds,
          maxCalls: LOCAL_LIMITS.tasksPerRoot,
          maxDepth: LOCAL_LIMITS.depth,
          maxConcurrent: 4,
          timeoutSeconds: 840,
          maxInputBytes: LOCAL_LIMITS.requestBytes,
          dataAllowance: "text_only" as const,
        }
      );
    });
    const remote = policy.targets.filter((target) => target.kind !== "local");
    await tx.agentSubAgent.deleteMany({ where: { parentId: agentId } });
    if (agentIds.length)
      await tx.agentSubAgent.createMany({
        data: agentIds.map((childId) => ({ parentId: agentId, childId })),
      });
    await tx.agent.update({
      where: { id: agentId },
      data: {
        subagentMode: native ? "native" : "platform",
        nativeSubagentMaxConcurrency: nativePolicy.maxConcurrency,
        nativeSubagentMaxDepth: nativePolicy.maxDepth,
        // Selecting children enables delegation; remote-only outbound stays as the A2A panel set it.
        a2aOutboundEnabled:
          local.length > 0 || (parent.a2aOutboundEnabled && remote.length > 0),
        a2aPolicy: { schemaVersion: 1, targets: [...remote, ...local] },
      },
    });
    return settings(
      {
        subagentMode: native ? "native" : "platform",
        nativeSubagentMaxConcurrency: nativePolicy.maxConcurrency,
        nativeSubagentMaxDepth: nativePolicy.maxDepth,
      },
      options.map((option) => ({
        ...option,
        checked: agentIds.includes(option.id),
      })),
    );
  });
}
