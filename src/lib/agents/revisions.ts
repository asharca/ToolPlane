import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
import { assertMarketReleasesExecutable } from "@/lib/pi-packages/revocation";
import {
  resolveDockerImageDigest,
  digestDockerVolume,
} from "@/lib/sandboxes/runtime";
import { AGENT_PI_PACKAGES_INCLUDE } from "./pi-package-includes";
import {
  AgentRevisionConfigSchema,
  AgentEnvironmentSnapshotSchema,
  AgentA2APolicySchema,
  AgentSkillSnapshotSchema,
} from "./revision-types";
import type {
  AgentRevisionConfig,
  AgentEnvironmentSnapshot,
} from "./revision-types";
import { resolveAgentPiPackages } from "./resolve";
import { assertAgentEnvironmentCredentialReferences } from "./environment-credentials";
import {
  preflightPiSdkCapabilities,
  nativePiMcpToolName,
} from "./sandbox-runtime";
import { MCP_RESULT_TO_FILE_TOOL } from "./native-tools";
import {
  mcpDefinitionChecksum,
  prepareSessionMcpDefinition,
  prepareExistingSessionMcpDefinition,
  mcpRuntimeFilesChecksum,
} from "@/lib/process/mcp-definition";
import { ensureWorkspaceMcpDeploymentPinned } from "@/lib/process/mcp-pinning";
import {
  exposedMcpToolNames,
  sameToolNames,
} from "@/lib/workspace/mcp-tool-exposure";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { piRuntimeCatalog } from "@/lib/agents/execution/runtime-tool-catalog";
import {
  externalSandboxTools,
  isExternalSandboxAccess,
  narrowExternalSandboxAccess,
} from "@/lib/sandboxes/external";
import { isExecutableAgentRuntimeKind } from "./runtime-kind";
import { preparePiRuntime } from "./pi-runtime";
import { resolveCapabilitySubagents } from "./subagents";

export class AgentRevisionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AgentRevisionError";
  }
}

/** Omission selects the published default. An explicit null is unresolved history. */
export async function requireAgentRevision(
  tx: Prisma.TransactionClient,
  agentId: string,
  revisionId?: string | null,
) {
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    select: {
      runtimeKind: true,
      retiredAt: true,
      currentRevisionVersion: true,
      workspace: { select: { status: true } },
    },
  });
  if (
    !agent ||
    !isExecutableAgentRuntimeKind(agent.runtimeKind) ||
    agent.retiredAt ||
    agent.workspace.status !== "active"
  )
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  if (revisionId === null)
    throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
  const revision =
    revisionId === undefined
      ? await tx.agentRevision.findUnique({
          where: {
            agentId_version: { agentId, version: agent.currentRevisionVersion },
          },
        })
      : await tx.agentRevision.findFirst({
          where: { id: revisionId, agentId },
        });
  if (!revision) throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
  const config = AgentRevisionConfigSchema.parse(revision.config);
  if (
    config.runtimeKind !== "pi-sdk" ||
    config.runtimeKind !== agent.runtimeKind
  )
    throw new AgentRevisionError("AGENT_RUNTIME_MISMATCH");
  await assertMarketReleasesExecutable(
    tx,
    config.packages.map((pkg) => pkg.releaseId),
  );
  return { id: revision.id, version: revision.version, config };
}

export const pinCurrentAgentRevision = (
  tx: Prisma.TransactionClient,
  agentId: string,
) => requireAgentRevision(tx, agentId);

/** The single-resource review and publication use the same complete installed artifact. */
export async function captureInstalledSkillSnapshot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  installedSkillId: string,
) {
  const skill = await tx.installedSkill.findFirst({
    where: { id: installedSkillId, workspaceId, status: "published" },
    include: {
      skill: true,
    },
  });
  if (!skill) throw new AgentRevisionError("resource_binding_unavailable");
  const artifact = {
    name: skill.name ?? skill.skill?.name ?? skill.id,
    slug: skill.slug ?? skill.skill?.slug ?? skill.id,
    description: skill.description ?? skill.skill?.description ?? null,
    markdown: buildInstalledSkillMarkdown(skill),
    files: installedSkillExtraFiles(skill),
  };
  return AgentSkillSnapshotSchema.parse({
    installedSkillId: skill.id,
    ...artifact,
    checksum: marketReleaseChecksum(artifact),
    userInvocable: skill.userInvocable,
    agentInvocable: skill.agentInvocable,
    effort: skill.effort,
  });
}

const captureInclude = {
  servers: { include: { deployment: true } },
  skills: { include: { installedSkill: { include: { skill: true } } } },
  knowledgeBases: true,
  sandboxes: { include: { sandbox: true } },
  externalSandboxes: {
    orderBy: { createdAt: "asc" },
    select: { sandboxId: true, access: true },
  },
  piPackages: AGENT_PI_PACKAGES_INCLUDE,
} as const;

/** Resolve and capture attached MCP recipes before entering a revision transaction. */
export async function prepareAgentRevisionMcpDeployments(
  workspaceId: string,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      runtimeKind: { in: ["pi-sdk"] },
      retiredAt: null,
      workspace: { status: "active" },
    },
    select: { servers: { select: { deploymentId: true } } },
  });
  if (!agent) throw new AgentRevisionError("AGENT_NOT_FOUND");
  for (const { deploymentId } of agent.servers) {
    const deployment = await ensureWorkspaceMcpDeploymentPinned({
      workspaceId,
      deploymentId,
    });
    await prepareSessionMcpDefinition(deployment);
  }
}

/** Capture artifacts, not mutable Skill ids or credentials. Transaction callers must prepare MCP deployments first. */
export async function captureAgentRevisionConfig(
  tx: Prisma.TransactionClient,
  agentId: string,
  environment?: AgentEnvironmentSnapshot,
): Promise<AgentRevisionConfig> {
  if (tx === db) {
    const owner = await db.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true },
    });
    if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
    await prepareAgentRevisionMcpDeployments(owner.workspaceId, agentId);
  }
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    include: captureInclude,
  });
  if (
    !agent ||
    !isExecutableAgentRuntimeKind(agent.runtimeKind) ||
    agent.retiredAt
  )
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  const previous =
    agent.currentRevisionVersion > 0
      ? await tx.agentRevision.findUnique({
          where: {
            agentId_version: { agentId, version: agent.currentRevisionVersion },
          },
        })
      : null;
  const prior = previous
    ? AgentRevisionConfigSchema.parse(previous.config)
    : null;
  const template = agent.sandboxes.find((link) => link.isDefault)?.sandbox;
  if (
    template?.config &&
    typeof template.config === "object" &&
    !Array.isArray(template.config) &&
    template.config.readOnly === true
  )
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  const frozenEnvironment =
    environment ??
    prior?.environment ??
    (template?.image
      ? {
          kind: "docker" as const,
          image: await resolveDockerImageDigest(template.image),
          network: template.network,
          piVersion: "0.87.1",
          initialSnapshot: null,
          resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
          credentialReferences: [],
        }
      : null);
  if (!frozenEnvironment)
    throw new AgentRevisionError("AGENT_ENVIRONMENT_REQUIRED");
  const packages = resolveAgentPiPackages(agent);
  return AgentRevisionConfigSchema.parse({
    schemaVersion: 1,
    runtimeKind: agent.runtimeKind,
    systemPrompt: agent.systemPrompt,
    providerId: agent.providerId,
    model: agent.model,
    modelProviderIds: [],
    maxSteps: agent.maxSteps,
    disabledBuiltinTools: agent.disabledBuiltinTools,
    sandboxTemplateId: template?.id ?? null,
    environment: frozenEnvironment,
    externalSandboxes: agent.externalSandboxes.map(({ sandboxId, access }) => ({
      sandboxId,
      access,
    })),
    // Dynamic native roles and platform A2A use no hand-authored definition pins.
    subagents: [],
    subagentMode: agent.subagentMode,
    nativeSubagentPolicy: {
      maxConcurrency: agent.nativeSubagentMaxConcurrency,
      maxDepth: agent.nativeSubagentMaxDepth,
    },
    skills: agent.skills.map(({ installedSkill: skill }) => {
      const artifact = {
        name: skill.name ?? skill.skill?.name ?? skill.id,
        slug: skill.slug ?? skill.skill?.slug ?? skill.id,
        description: skill.description ?? skill.skill?.description ?? null,
        markdown: buildInstalledSkillMarkdown(skill),
        files: installedSkillExtraFiles(skill),
      };
      return {
        installedSkillId: skill.id,
        ...artifact,
        checksum: marketReleaseChecksum(artifact),
        userInvocable: skill.userInvocable,
        agentInvocable: skill.agentInvocable,
        effort: skill.effort,
      };
    }),
    knowledgeBaseIds: agent.knowledgeBases.map(
      (entry) => entry.knowledgeBaseId,
    ),
    packages: packages.map((pkg) => ({
      marketInstallId: pkg.marketInstallId,
      releaseId: pkg.releaseId,
      integrity: pkg.checksum,
    })),
    // The live binding is authoritative: `all` bindings are kept equal to the
    // catalog, `selected` bindings hold the user's explicit subset.
    mcpGrants: await Promise.all(
      agent.servers.map(
        async ({ deploymentId, deployment, allowedToolNames }) => ({
          deploymentId,
          ...(await prepareSessionMcpDefinition(deployment, {
            prepare: false,
          })),
          runtimeFilesChecksum: await mcpRuntimeFilesChecksum(tx, deploymentId),
          allowedToolNames: exposedMcpToolNames(deployment, allowedToolNames),
        }),
      ),
    ),
    a2a: {
      inboundEnabled: agent.a2aInboundEnabled,
      outboundEnabled: agent.a2aOutboundEnabled,
      policy: AgentA2APolicySchema.parse(
        agent.a2aPolicy ?? { schemaVersion: 1, targets: [] },
      ),
    },
  });
}

async function validateRevisionAuthorization(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  config: AgentRevisionConfig,
) {
  const agent = await tx.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      runtimeKind: config.runtimeKind,
      retiredAt: null,
      workspace: { status: "active" },
    },
    include: captureInclude,
  });
  if (!agent) throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  if ((config.subagentMode ?? "platform") !== agent.subagentMode)
    throw new AgentRevisionError("SUBAGENT_MODE_CONFLICT");
  if (
    config.subagentMode === "native" &&
    (!config.nativeSubagentPolicy ||
      config.nativeSubagentPolicy.maxConcurrency >
        agent.nativeSubagentMaxConcurrency ||
      config.nativeSubagentPolicy.maxDepth > agent.nativeSubagentMaxDepth)
  )
    throw new AgentRevisionError("SUBAGENT_POLICY_REVOKED");
  const providers = new Set([agent.providerId]);
  if (
    (config.providerId && !providers.has(config.providerId)) ||
    config.modelProviderIds.some((id) => !providers.has(id))
  )
    throw new AgentRevisionError("AGENT_PROVIDER_REVOKED");
  const skills = new Set(agent.skills.map((entry) => entry.installedSkillId));
  const knowledge = new Set(
    agent.knowledgeBases.map((entry) => entry.knowledgeBaseId),
  );
  const deployments = new Set(agent.servers.map((entry) => entry.deploymentId));
  if (
    config.skills.some((skill) => !skills.has(skill.installedSkillId)) ||
    config.knowledgeBaseIds.some((id) => !knowledge.has(id)) ||
    config.mcpGrants.some((grant) => !deployments.has(grant.deploymentId))
  )
    throw new AgentRevisionError("AGENT_GRANT_REVOKED");
  for (const pinned of config.externalSandboxes) {
    const live = agent.externalSandboxes.find(
      (entry) => entry.sandboxId === pinned.sandboxId,
    );
    if (
      !live ||
      !isExternalSandboxAccess(live.access) ||
      narrowExternalSandboxAccess(pinned.access, live.access) !== pinned.access
    )
      throw new AgentRevisionError("AGENT_GRANT_REVOKED");
  }
  for (const grant of config.mcpGrants) {
    const deployment = agent.servers.find(
      (entry) => entry.deploymentId === grant.deploymentId,
    )?.deployment;
    const liveTools =
      agent.servers.find((entry) => entry.deploymentId === grant.deploymentId)
        ?.allowedToolNames ?? [];
    if (grant.allowedToolNames.some((name) => !liveTools.includes(name)))
      throw new AgentRevisionError("AGENT_GRANT_REVOKED");
    if (
      !deployment ||
      grant.definitionChecksum !== mcpDefinitionChecksum(deployment) ||
      grant.runtimeFilesChecksum !==
        (await mcpRuntimeFilesChecksum(tx, grant.deploymentId))
    )
      throw new AgentRevisionError("MCP_DEFINITION_CHANGED");
    const prepared = await prepareExistingSessionMcpDefinition(
      deployment,
      grant.runtimeImageDigest,
    );
    if (prepared.runtimeImageDigest !== grant.runtimeImageDigest)
      throw new AgentRevisionError("MCP_DEFINITION_CHANGED");
  }
  for (const skill of config.skills) {
    if (
      skill.checksum !==
      marketReleaseChecksum({
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        markdown: skill.markdown,
        files: skill.files,
      })
    )
      throw new AgentRevisionError("AGENT_SKILL_CHECKSUM_MISMATCH");
  }
  if (
    (config.a2a.inboundEnabled && !agent.a2aInboundEnabled) ||
    (config.a2a.outboundEnabled && !agent.a2aOutboundEnabled)
  )
    throw new AgentRevisionError("AGENT_A2A_GRANT_REVOKED");
  const livePolicy = AgentA2APolicySchema.parse(
    agent.a2aPolicy ?? { schemaVersion: 1, targets: [] },
  );
  for (const target of config.a2a.policy.targets) {
    const matches = livePolicy.targets.filter(
      (entry) =>
        entry.kind === target.kind && entry.targetId === target.targetId,
    );
    const liveTarget = matches[0];
    if (
      matches.length !== 1 ||
      !liveTarget ||
      target.capabilityIds.some(
        (id) => !liveTarget.capabilityIds.includes(id),
      ) ||
      target.maxCalls > liveTarget.maxCalls ||
      target.maxDepth > liveTarget.maxDepth ||
      target.maxConcurrent > liveTarget.maxConcurrent ||
      target.timeoutSeconds > liveTarget.timeoutSeconds ||
      target.maxInputBytes > liveTarget.maxInputBytes ||
      (liveTarget.budget &&
        (!target.budget ||
          target.budget.currency !== liveTarget.budget.currency ||
          target.budget.maxAuthorizedCostMicros >
            liveTarget.budget.maxAuthorizedCostMicros ||
          target.budget.authorizedCostPerCallMicros <
            liveTarget.budget.authorizedCostPerCallMicros))
    )
      throw new AgentRevisionError("AGENT_A2A_GRANT_REVOKED");
  }
  const packages = [];
  let retainedRevisionId: string | undefined;
  for (const pin of config.packages) {
    const binding = agent.piPackages.find(
      (entry) =>
        entry.marketInstallId === pin.marketInstallId &&
        entry.releaseId === pin.releaseId,
    );
    if (
      binding?.marketInstall.status !== "ready" ||
      binding.marketInstall.listing.status !== "published"
    ) {
      const retained = await tx.agentRevision.findFirst({
        where: {
          agentId,
          config: { path: ["packages"], array_contains: [pin] },
        },
        select: { id: true },
      });
      if (!retained) throw new AgentRevisionError("PI_PACKAGE_UNAVAILABLE");
      retainedRevisionId = retained.id;
    }
    const marketInstall =
      binding?.marketInstall ??
      (await tx.marketInstall.findFirst({
        where: { id: pin.marketInstallId, targetWorkspaceId: workspaceId },
        include: { listing: true },
      }));
    const release =
      binding?.release ??
      (await tx.marketRelease.findUnique({ where: { id: pin.releaseId } }));
    if (!marketInstall || !release || release.checksum !== pin.integrity)
      throw new AgentRevisionError("PI_PACKAGE_UNAVAILABLE");
    packages.push({
      marketInstallId: pin.marketInstallId,
      marketInstall,
      releaseId: pin.releaseId,
      release,
    });
  }
  resolveAgentPiPackages({
    ...agent,
    piPackages: packages,
    agentRevisionId: retainedRevisionId,
  });
  await assertMarketReleasesExecutable(
    tx,
    config.packages.map((pkg) => pkg.releaseId),
  );
  const children = await resolveCapabilitySubagents(
    tx,
    workspaceId,
    agentId,
    config,
  );
  if (children.length !== (config.subagents?.length ?? 0))
    throw new AgentRevisionError("SUBAGENT_REVOKED");
  if (config.nativeRoleModels?.length)
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  await assertAgentEnvironmentCredentialReferences(
    tx,
    workspaceId,
    agentId,
    config.environment.credentialReferences,
  );
  return {
    ...agent,
    piPackages: packages,
    agentRevisionId: retainedRevisionId,
  };
}

export type PublishAgentRevisionInput = {
  expectedRevisionId: string | null;
  config?: unknown;
  environment?: AgentEnvironmentSnapshot;
};

/** Caller holds the transaction: CAS, validation and publication are one atomic change. */
export async function publishAgentRevisionInTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  input: {
    expectedRevisionId: string | null;
    config: unknown;
    purpose?: "candidate" | "rollback" | "published";
  },
) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${agentId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
  const owner = await tx.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { currentRevisionVersion: true },
  });
  if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
  const current = owner.currentRevisionVersion
    ? await tx.agentRevision.findUnique({
        where: {
          agentId_version: { agentId, version: owner.currentRevisionVersion },
        },
        select: { id: true },
      })
    : null;
  if ((current?.id ?? null) !== input.expectedRevisionId)
    throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
  const config = AgentRevisionConfigSchema.parse(input.config);
  if (config.subagents?.length)
    throw new AgentRevisionError("SUBAGENT_AUTHORING_RETIRED");
  if (!isExecutableAgentRuntimeKind(config.runtimeKind))
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  AgentEnvironmentSnapshotSchema.parse(config.environment);
  if (
    config.runtimeKind === "pi-sdk" &&
    config.environment.piVersion !== "0.87.1"
  )
    throw new AgentRevisionError("PI_SDK_VERSION_MISMATCH");
  const authorized = await validateRevisionAuthorization(
    tx,
    workspaceId,
    agentId,
    config,
  );
  if (current && !input.purpose) {
    const existing = await tx.agentRevision.findUniqueOrThrow({
      where: { id: current.id },
    });
    if (isDeepStrictEqual(existing.config, config))
      return { id: existing.id, version: existing.version, config };
  }
  const initialSnapshot = config.environment.initialSnapshot;
  if (initialSnapshot) {
    const snapshot = await tx.sandboxSnapshot.findFirst({
      where: {
        id: initialSnapshot.snapshotId,
        volumeName: initialSnapshot.volumeName,
        status: "ready",
        sandboxId: config.sandboxTemplateId ?? "",
        sandbox: { workspaceId, agentLinks: { some: { agentId } } },
      },
      select: { id: true },
    });
    if (
      !snapshot ||
      (await digestDockerVolume(initialSnapshot.volumeName)) !==
        initialSnapshot.checksum
    )
      throw new AgentRevisionError("AGENT_INITIAL_SNAPSHOT_INVALID");
  }
  if (config.runtimeKind === "pi-sdk") {
    const nativeToolNames = config.mcpGrants.flatMap((grant, serverIndex) => {
      const deployment = authorized.servers.find(
        (entry) => entry.deploymentId === grant.deploymentId,
      )?.deployment;
      if (!deployment) throw new AgentRevisionError("AGENT_GRANT_REVOKED");
      return readMcpToolCatalog(deployment.installCfg)
        .filter(
          (tool) =>
            grant.allowedToolNames.includes(tool.name) &&
            (deployment.mcpToolExposure !== "allowlist" ||
              deployment.mcpAllowedTools.includes(tool.name)),
        )
        .map((tool, toolIndex) =>
          nativePiMcpToolName(serverIndex, toolIndex, tool.name),
        );
    });
    if (nativeToolNames.length) nativeToolNames.push(MCP_RESULT_TO_FILE_TOOL);
    // Session servers: MCP grants, then external sandboxes, then the task server.
    for (const [index, entry] of config.externalSandboxes.entries())
      nativeToolNames.push(
        ...externalSandboxTools(entry.access).map((tool, toolIndex) =>
          nativePiMcpToolName(config.mcpGrants.length + index, toolIndex, tool),
        ),
      );
    nativeToolNames.push(
      ...piRuntimeCatalog(config.a2a.outboundEnabled).map((tool, toolIndex) =>
        nativePiMcpToolName(
          config.mcpGrants.length + config.externalSandboxes.length,
          toolIndex,
          tool.name,
        ),
      ),
    );
    await preflightPiSdkCapabilities({
      piPackages: resolveAgentPiPackages({
        ...authorized,
        piPackages: authorized.piPackages.filter((binding) =>
          config.packages.some(
            (pin) =>
              pin.marketInstallId === binding.marketInstallId &&
              pin.releaseId === binding.releaseId,
          ),
        ),
      }),
      skills: config.skills.map((skill) => ({
        skillId: null,
        skill: null,
        name: skill.name,
        slug: skill.slug,
        content: skill.markdown,
        files: skill.files,
        userInvocable: skill.userInvocable,
        agentInvocable: skill.agentInvocable,
      })),
      toolNames: nativeToolNames,
    });
  }
  await validateRevisionAuthorization(tx, workspaceId, agentId, config);
  // Candidates consume sequence numbers but never become the default implicitly.
  const latest = await tx.agentRevision.aggregate({
    where: { agentId },
    _max: { version: true },
  });
  const revision = await tx.agentRevision.create({
    data: {
      agentId,
      version: (latest._max.version ?? 0) + 1,
      parentRevisionId: current?.id ?? null,
      purpose: input.purpose ?? "published",
      config: config as Prisma.InputJsonValue,
    },
  });
  if (input.purpose !== "candidate")
    await tx.agent.update({
      where: { id: agentId },
      data: { currentRevisionVersion: revision.version },
    });
  return { id: revision.id, version: revision.version, config };
}

/**
 * Follow MCP catalog, exposure and recipe changes for MCP grants the current
 * revision already holds. Publishes the applied configuration with only those
 * grants refreshed; unapplied Agent edits are never published here. Returns the
 * new revision, or null when the applied grants are already current.
 */
export async function refreshAgentRevisionMcpGrants(
  workspaceId: string,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      runtimeKind: { in: ["pi-sdk"] },
      retiredAt: null,
    },
    select: {
      currentRevisionVersion: true,
      servers: { include: { deployment: true } },
    },
  });
  if (!agent?.currentRevisionVersion) return null;
  const current = await db.agentRevision.findUnique({
    where: {
      agentId_version: { agentId, version: agent.currentRevisionVersion },
    },
  });
  if (!current) return null;
  const applied = AgentRevisionConfigSchema.parse(current.config);
  const recipeChanged = async (
    grant: AgentRevisionConfig["mcpGrants"][number],
    deployment: Parameters<typeof mcpDefinitionChecksum>[0],
  ) =>
    grant.definitionChecksum !== mcpDefinitionChecksum(deployment) ||
    grant.runtimeFilesChecksum !==
      (await mcpRuntimeFilesChecksum(db, grant.deploymentId));
  let stale = false;
  for (const grant of applied.mcpGrants) {
    const binding = agent.servers.find(
      (entry) => entry.deploymentId === grant.deploymentId,
    );
    if (!binding) continue;
    if (await recipeChanged(grant, binding.deployment)) {
      // Image capture must happen outside the publication transaction.
      await ensureWorkspaceMcpDeploymentPinned({
        workspaceId,
        deploymentId: grant.deploymentId,
      });
      await prepareSessionMcpDefinition(binding.deployment);
      stale = true;
    } else if (
      !sameToolNames(
        grant.allowedToolNames,
        exposedMcpToolNames(binding.deployment, binding.allowedToolNames),
      )
    )
      stale = true;
  }
  if (!stale) return null;
  return db.$transaction(
    async (tx) => {
      const live = await tx.agent.findFirst({
        where: { id: agentId, workspaceId },
        select: {
          servers: { include: { deployment: true } },
          externalSandboxes: { select: { sandboxId: true, access: true } },
        },
      });
      if (!live) throw new AgentRevisionError("AGENT_NOT_FOUND");
      const mcpGrants = await Promise.all(
        applied.mcpGrants.map(async (grant) => {
          const binding = live.servers.find(
            (entry) => entry.deploymentId === grant.deploymentId,
          );
          // A removed binding is a revocation; runtime already narrows it.
          if (!binding) return grant;
          return {
            deploymentId: grant.deploymentId,
            ...(await prepareSessionMcpDefinition(binding.deployment, {
              prepare: false,
            })),
            runtimeFilesChecksum: await mcpRuntimeFilesChecksum(
              tx,
              grant.deploymentId,
            ),
            allowedToolNames: exposedMcpToolNames(
              binding.deployment,
              binding.allowedToolNames,
            ),
          };
        }),
      );
      // Never widen: keep only still-attached sandboxes at the lower access.
      const externalSandboxes = applied.externalSandboxes.flatMap((entry) => {
        const attached = live.externalSandboxes.find(
          (item) => item.sandboxId === entry.sandboxId,
        );
        return attached && isExternalSandboxAccess(attached.access)
          ? [
              {
                sandboxId: entry.sandboxId,
                access: narrowExternalSandboxAccess(
                  entry.access,
                  attached.access,
                ),
              },
            ]
          : [];
      });
      return publishAgentRevisionInTransaction(tx, workspaceId, agentId, {
        expectedRevisionId: current.id,
        config: { ...applied, mcpGrants, externalSandboxes },
      });
    },
    { timeout: 120_000 },
  );
}

/** Removing a default package grants nothing; preserve all other applied scopes, even revoked ones. */
export async function removeAgentRevisionPackageInTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  expectedRevisionId: string,
  marketInstallId: string,
) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${agentId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
  const owner = await tx.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      currentRevisionVersion: true,
      runtimeKind: true,
      retiredAt: true,
    },
  });
  if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
  if (!isExecutableAgentRuntimeKind(owner.runtimeKind) || owner.retiredAt)
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  const current = await tx.agentRevision.findUnique({
    where: {
      agentId_version: { agentId, version: owner.currentRevisionVersion },
    },
  });
  if (!current) throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
  if (current.id !== expectedRevisionId)
    throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
  const applied = AgentRevisionConfigSchema.parse(current.config);
  const config = {
    ...applied,
    packages: applied.packages.filter(
      (pkg) => pkg.marketInstallId !== marketInstallId,
    ),
    ...(applied.nativeRoleModels !== undefined
      ? {
          nativeRoleModels: applied.nativeRoleModels.filter(
            (role) => role.marketInstallId !== marketInstallId,
          ),
        }
      : {}),
  };
  const revision = await tx.agentRevision.create({
    data: {
      agentId,
      version: owner.currentRevisionVersion + 1,
      config: config as Prisma.InputJsonValue,
    },
  });
  await tx.agent.update({
    where: { id: agentId },
    data: { currentRevisionVersion: revision.version },
  });
  return { id: revision.id, version: revision.version, config };
}

export async function publishAgentRevision(
  workspaceId: string,
  agentId: string,
  input: PublishAgentRevisionInput,
) {
  const owner = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true },
  });
  if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
  const config =
    input.config === undefined
      ? await captureAgentRevisionConfig(db, agentId, input.environment)
      : input.config;
  const preparedConfig = AgentRevisionConfigSchema.parse(config);
  if (!isExecutableAgentRuntimeKind(preparedConfig.runtimeKind))
    throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  if (preparedConfig.runtimeKind === "pi-sdk") await preparePiRuntime();
  return db.$transaction(
    (tx) =>
      publishAgentRevisionInTransaction(tx, workspaceId, agentId, {
        expectedRevisionId: input.expectedRevisionId,
        config: preparedConfig,
      }),
    { timeout: 120_000 },
  );
}

/** Rollback is a newly authorized publication, never a pointer rewind. */
export async function rollbackAgentRevision(
  workspaceId: string,
  agentId: string,
  revisionId: string,
  expectedRevisionId: string,
) {
  const owner = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { runtimeKind: true },
  });
  if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
  if (owner.runtimeKind === "pi-sdk") await preparePiRuntime();
  return db.$transaction(
    async (tx) => {
      const revision = await requireAgentRevision(tx, agentId, revisionId);
      return publishAgentRevisionInTransaction(tx, workspaceId, agentId, {
        expectedRevisionId,
        config: revision.config,
        purpose: "rollback",
      });
    },
    { timeout: 120_000 },
  );
}

/** Immutable execution settings, narrowed by current ownership and revocation. */
export async function resolvePinnedAgent<
  T extends { id: string; workspaceId: string; runtimeKind: string },
>(
  agent: T,
  revisionId: string | null | undefined,
  options?: { workspaceId?: string },
) {
  if (!revisionId) throw new AgentRevisionError("AGENT_REVISION_UNRESOLVED");
  if (options?.workspaceId && options.workspaceId !== agent.workspaceId)
    throw new AgentRevisionError("AGENT_NOT_FOUND");
  return db.$transaction(async (tx) => {
    const { config, id } = await requireAgentRevision(tx, agent.id, revisionId);
    const live = await tx.agent.findFirst({
      where: { id: agent.id, workspaceId: agent.workspaceId },
      include: {
        ...captureInclude,
        knowledgeBases: {
          include: { knowledgeBase: { include: { provider: true } } },
        },
      },
    });
    if (!live) throw new AgentRevisionError("AGENT_NOT_FOUND");
    if (
      live.runtimeKind !== config.runtimeKind ||
      agent.runtimeKind !== config.runtimeKind
    )
      throw new AgentRevisionError("AGENT_RUNTIME_MISMATCH");
    // Draft defaults do not change an immutable session's provider authority.
    const provider = config.providerId
      ? await tx.modelProvider.findFirst({
          where: { id: config.providerId, workspaceId: agent.workspaceId },
        })
      : null;
    if (config.providerId && !provider?.apiKey.trim())
      throw new AgentRevisionError("AGENT_PROVIDER_REVOKED");
    const skillIds = new Set(
      live.skills
        .filter((entry) => entry.installedSkill.status === "published")
        .map((entry) => entry.installedSkillId),
    );
    const deploymentIds = new Set(
      live.servers.map((entry) => entry.deploymentId),
    );
    const approvedPackages = [];
    for (const pin of config.packages) {
      const marketInstall = await tx.marketInstall.findFirst({
        where: {
          id: pin.marketInstallId,
          targetWorkspaceId: agent.workspaceId,
        },
        include: { listing: true },
      });
      const release = await tx.marketRelease.findUnique({
        where: { id: pin.releaseId },
      });
      if (
        !marketInstall ||
        (marketInstall.status !== "ready" &&
          marketInstall.status !== "uninstalled") ||
        !release ||
        release.checksum !== pin.integrity ||
        release.listingId !== marketInstall.listingId
      )
        throw new AgentRevisionError("PI_PACKAGE_UNAVAILABLE");
      approvedPackages.push({
        marketInstallId: pin.marketInstallId,
        marketInstall,
        releaseId: pin.releaseId,
        release,
      });
    }
    const grants = config.mcpGrants
      .filter((grant) => deploymentIds.has(grant.deploymentId))
      .map((grant) => ({
        ...grant,
        allowedToolNames: grant.allowedToolNames.filter((name) =>
          live.servers.some(
            (entry) =>
              entry.deploymentId === grant.deploymentId &&
              entry.allowedToolNames.includes(name),
          ),
        ),
      }));
    const capabilitySubagents = await resolveCapabilitySubagents(
      tx,
      agent.workspaceId,
      agent.id,
      config,
    );
    return {
      ...agent,
      runtimeKind: config.runtimeKind,
      agentRevisionId: id,
      revisionConfig: config,
      // Never inherit a draft mode into a pinned historical session.
      subagentMode: config.subagentMode,
      nativeSubagentMaxConcurrency: config.nativeSubagentPolicy?.maxConcurrency,
      nativeSubagentMaxDepth: config.nativeSubagentPolicy?.maxDepth,
      systemPrompt: config.systemPrompt,
      providerId: config.providerId,
      provider,
      model: config.model,
      maxSteps: config.maxSteps,
      disabledBuiltinTools: [
        ...new Set([
          ...config.disabledBuiltinTools,
          ...live.disabledBuiltinTools,
        ]),
      ],
      servers: grants.map((grant) => ({ deploymentId: grant.deploymentId })),
      mcpToolPolicy: Object.fromEntries(
        grants.map((grant) => [grant.deploymentId, grant.allowedToolNames]),
      ),
      skills: config.skills
        .filter((skill) => skillIds.has(skill.installedSkillId))
        .map((skill) => ({
          installedSkill: {
            id: skill.installedSkillId,
            skillId: null,
            skill: null,
            name: skill.name,
            slug: skill.slug,
            description: skill.description,
            content: skill.markdown,
            files: skill.files,
            userInvocable: skill.userInvocable,
            agentInvocable: skill.agentInvocable,
            effort: skill.effort,
            status: "published",
          },
        })),
      piPackages: approvedPackages,
      toolkits: [],
      subAgents: [],
      capabilitySubagents,
      knowledgeBases: live.knowledgeBases.filter((entry) =>
        config.knowledgeBaseIds.includes(entry.knowledgeBaseId),
      ),
      a2aInboundEnabled: config.a2a.inboundEnabled && live.a2aInboundEnabled,
      a2aOutboundEnabled: config.a2a.outboundEnabled && live.a2aOutboundEnabled,
    };
  });
}
