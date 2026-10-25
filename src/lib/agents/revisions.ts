import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
import { assertMarketReleasesExecutable } from "@/lib/market/revocation";
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
import {
  mcpDefinitionChecksum,
  prepareSessionMcpDefinition,
  prepareExistingSessionMcpDefinition,
  mcpRuntimeFilesChecksum,
} from "@/lib/process/mcp-definition";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { piCommunicationCatalog } from "@/lib/a2a/pi-tool-catalog";

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
    agent?.runtimeKind !== "pi-sdk" ||
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
      marketInstall: { include: { listing: true, currentRelease: true } },
    },
  });
  if (!skill) throw new AgentRevisionError("resource_binding_unavailable");
  const install = skill.marketInstall;
  if (
    install &&
    (!["ready", "modified", "setup_required"].includes(install.status) ||
      install.currentRelease.reviewStatus !== "approved" ||
      install.currentRelease.listingId !== install.listingId ||
      install.listing.status !== "published" ||
      (install.listing.visibility !== "public" &&
        install.listing.publisherWorkspaceId !== workspaceId))
  )
    throw new AgentRevisionError("resource_binding_unavailable");
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
  modelProviders: true,
  servers: { include: { deployment: true } },
  skills: { include: { installedSkill: { include: { skill: true } } } },
  knowledgeBases: true,
  sandboxes: { include: { sandbox: true } },
  piPackages: AGENT_PI_PACKAGES_INCLUDE,
} as const;

/** Capture artifacts, not mutable Skill ids. No environment values/credentials are copied. */
export async function captureAgentRevisionConfig(
  tx: Prisma.TransactionClient,
  agentId: string,
  environment?: AgentEnvironmentSnapshot,
): Promise<AgentRevisionConfig> {
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    include: captureInclude,
  });
  if (agent?.runtimeKind !== "pi-sdk" || agent.retiredAt)
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
    runtimeKind: "pi-sdk",
    systemPrompt: agent.systemPrompt,
    providerId: agent.providerId,
    model: agent.model,
    modelProviderIds: agent.modelProviders.map((entry) => entry.providerId),
    maxSteps: agent.maxSteps,
    disabledBuiltinTools: agent.disabledBuiltinTools,
    sandboxTemplateId: template?.id ?? null,
    environment: frozenEnvironment,
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
    // A mutable deployment attachment is not consent to every present/future tool.
    mcpGrants: await Promise.all(
      agent.servers.map(
        async ({ deploymentId, deployment, allowedToolNames }) => ({
          deploymentId,
          ...(await prepareSessionMcpDefinition(deployment)),
          runtimeFilesChecksum: await mcpRuntimeFilesChecksum(tx, deploymentId),
          allowedToolNames: (
            prior?.mcpGrants.find(
              (grant) => grant.deploymentId === deploymentId,
            )?.allowedToolNames ?? allowedToolNames
          ).filter(
            (name) =>
              allowedToolNames.includes(name) &&
              (deployment.mcpToolExposure !== "allowlist" ||
                deployment.mcpAllowedTools.includes(name)),
          ),
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
      runtimeKind: "pi-sdk",
      retiredAt: null,
      workspace: { status: "active" },
    },
    include: captureInclude,
  });
  if (!agent) throw new AgentRevisionError("AGENT_EXECUTION_RETIRED");
  const providers = new Set([
    agent.providerId,
    ...agent.modelProviders.map((entry) => entry.providerId),
  ]);
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
  input: { expectedRevisionId: string | null; config: unknown },
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
  AgentEnvironmentSnapshotSchema.parse(config.environment);
  if (config.environment.piVersion !== "0.87.1")
    throw new AgentRevisionError("PI_SDK_VERSION_MISMATCH");
  const authorized = await validateRevisionAuthorization(
    tx,
    workspaceId,
    agentId,
    config,
  );
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
  if (config.a2a.outboundEnabled)
    nativeToolNames.push(
      ...piCommunicationCatalog.map((tool, toolIndex) =>
        nativePiMcpToolName(config.mcpGrants.length, toolIndex, tool.name),
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
  await validateRevisionAuthorization(tx, workspaceId, agentId, config);
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
    select: { currentRevisionVersion: true },
  });
  if (!owner) throw new AgentRevisionError("AGENT_NOT_FOUND");
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
  const config =
    input.config === undefined
      ? await captureAgentRevisionConfig(db, agentId, input.environment)
      : input.config;
  return db.$transaction(
    (tx) =>
      publishAgentRevisionInTransaction(tx, workspaceId, agentId, {
        expectedRevisionId: input.expectedRevisionId,
        config,
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
  return db.$transaction(
    async (tx) => {
      const revision = await requireAgentRevision(tx, agentId, revisionId);
      return publishAgentRevisionInTransaction(tx, workspaceId, agentId, {
        expectedRevisionId,
        config: revision.config,
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
        provider: true,
        modelProviders: { include: { provider: true } },
        knowledgeBases: {
          include: { knowledgeBase: { include: { provider: true } } },
        },
      },
    });
    if (!live) throw new AgentRevisionError("AGENT_NOT_FOUND");
    const providerIds = new Set([
      live.providerId,
      ...live.modelProviders.map((entry) => entry.providerId),
    ]);
    if (config.providerId && !providerIds.has(config.providerId))
      throw new AgentRevisionError("AGENT_PROVIDER_REVOKED");
    const provider = config.providerId
      ? await tx.modelProvider.findFirst({
          where: { id: config.providerId, workspaceId: agent.workspaceId },
        })
      : null;
    if (config.providerId && !provider)
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
    return {
      ...agent,
      runtimeKind: "pi-sdk",
      agentRevisionId: id,
      revisionConfig: config,
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
      modelProviders: live.modelProviders.filter((entry) =>
        config.modelProviderIds.includes(entry.providerId),
      ),
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
      knowledgeBases: live.knowledgeBases.filter((entry) =>
        config.knowledgeBaseIds.includes(entry.knowledgeBaseId),
      ),
      a2aInboundEnabled: config.a2a.inboundEnabled && live.a2aInboundEnabled,
      a2aOutboundEnabled: config.a2a.outboundEnabled && live.a2aOutboundEnabled,
    };
  });
}
