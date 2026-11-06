import "server-only";
import type { Prisma } from "@prisma/client";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { PluginError } from "@/lib/plugins/catalog";
import { SubagentDefinitionSchema } from "./capability-contracts";
import type { AgentRevisionConfig } from "./revision-types";
import {
  resolveAgentModelOverride,
  AgentModelOverrideError,
} from "./turn-model";

// Compatibility resolver for already-published immutable native child snapshots only.

/** Parent immutable grants are the ceiling; live draft grants can only narrow it. */
export async function resolveCapabilitySubagents(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  config: AgentRevisionConfig,
) {
  const pins = config.subagents ?? [];
  const parent = await tx.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      retiredAt: null,
      workspace: { status: "active" },
    },
    include: {
      servers: true,
      skills: { include: { installedSkill: true } },
      piPackages: {
        include: {
          release: true,
          marketInstall: { include: { listing: true } },
        },
      },
    },
  });
  if (!parent)
    throw new PluginError("SUBAGENT_REVOKED", "Parent unavailable.", 403);
  const result = [];
  for (const pin of pins) {
    const binding = await tx.agentSubagentBinding.findFirst({
      where: {
        agentId,
        subagentId: pin.subagentId,
        enabled: true,
        subagent: { workspaceId, revokedAt: null },
      },
      include: { subagent: true, version: true },
    });
    // Keep historical code/prompt pins; current bindings can only revoke authority.
    const version =
      binding &&
      (await tx.workspaceSubagentVersion.findFirst({
        where: {
          id: pin.versionId,
          subagentId: pin.subagentId,
          checksum: pin.checksum,
        },
      }));
    if (!binding || !version) continue;
    const definition = SubagentDefinitionSchema.parse(version.definition);
    const liveDefinition = SubagentDefinitionSchema.parse(
      binding.version.definition,
    );
    if (
      definition.model &&
      (liveDefinition.model?.providerId !== definition.model.providerId ||
        liveDefinition.model?.model !== definition.model.model)
    )
      continue;
    if (
      definition.runtimeKind !== config.runtimeKind ||
      marketReleaseChecksum(version.definition) !== pin.checksum
    )
      throw new PluginError(
        "SUBAGENT_VERSION_FORBIDDEN",
        "Invalid child snapshot.",
        403,
      );
    let provider: { id: string; name: string; format: string } | null = null;
    if (definition.model) {
      try {
        const selected = await resolveAgentModelOverride(
          workspaceId,
          definition.model,
          definition.runtimeKind,
          tx,
        );
        provider = {
          id: selected.provider.id,
          name: selected.provider.name,
          format: selected.provider.format,
        };
      } catch (error) {
        if (!(error instanceof AgentModelOverrideError)) throw error;
        continue;
      }
    }
    const permissions = {
      builtinTools: definition.permissions.builtinTools.filter(
        (tool) =>
          liveDefinition.permissions.builtinTools.includes(tool) &&
          !config.disabledBuiltinTools.includes(tool) &&
          !parent.disabledBuiltinTools.includes(tool),
      ),
      mcpTools: definition.permissions.mcpTools
        .map((grant) => ({
          deploymentId: grant.deploymentId,
          tools: grant.tools.filter(
            (tool) =>
              liveDefinition.permissions.mcpTools.some(
                (live) =>
                  live.deploymentId === grant.deploymentId &&
                  live.tools.includes(tool),
              ) &&
              config.mcpGrants.some(
                (pinned) =>
                  pinned.deploymentId === grant.deploymentId &&
                  pinned.allowedToolNames.includes(tool),
              ) &&
              parent.servers.some(
                (live) =>
                  live.deploymentId === grant.deploymentId &&
                  live.allowedToolNames.includes(tool),
              ),
          ),
        }))
        .filter((grant) => grant.tools.length),
      skillIds: definition.permissions.skillIds.filter(
        (id) =>
          liveDefinition.permissions.skillIds.includes(id) &&
          config.skills.some((skill) => skill.installedSkillId === id) &&
          parent.skills.some(
            (skill) =>
              skill.installedSkillId === id &&
              skill.installedSkill.status === "published",
          ),
      ),
      pluginInstallIds: (definition.permissions.pluginInstallIds ?? []).filter(
        (id) =>
          (liveDefinition.permissions.pluginInstallIds ?? []).includes(id) &&
          config.packages.some(
            (pinned) =>
              pinned.marketInstallId === id &&
              parent.piPackages.some(
                (live) =>
                  live.marketInstallId === id &&
                  live.releaseId === pinned.releaseId &&
                  live.release.reviewStatus === "approved" &&
                  live.marketInstall.status === "ready" &&
                  live.marketInstall.listing.status === "published",
              ),
          ),
      ),
    };
    result.push({
      ...pin,
      name: definition.name ?? binding.subagent.name,
      definition: {
        ...definition,
        permissions,
        allowNested: definition.allowNested && liveDefinition.allowNested,
        maxDepth: Math.min(definition.maxDepth, liveDefinition.maxDepth),
        maxConcurrency: Math.min(
          definition.maxConcurrency,
          liveDefinition.maxConcurrency,
        ),
        maxSteps: Math.min(definition.maxSteps, liveDefinition.maxSteps),
      },
      provider,
    });
  }
  return result;
}

export async function assertSubagentRuntimeAccess(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    agentId: string;
    subagentId: string;
    versionId: string;
    config: AgentRevisionConfig;
  },
) {
  const child = (
    await resolveCapabilitySubagents(
      tx,
      input.workspaceId,
      input.agentId,
      input.config,
    )
  ).find(
    (entry) =>
      entry.subagentId === input.subagentId &&
      entry.versionId === input.versionId,
  );
  if (!child)
    throw new PluginError("SUBAGENT_REVOKED", "Subagent grant revoked.", 403);
  return child;
}
