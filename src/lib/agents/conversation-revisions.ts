import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  AgentRevisionConfigSchema,
  type AgentRevisionConfig,
} from "./revision-types";
import { requireAgentRevision } from "./revisions";
import { resolvePiSessionPackages } from "./pi-session-packages";
import {
  acquireConversationOperation,
  conversationOperationKey,
} from "./conversation-operations";
import {
  AgentExecutionBusyError,
  withAgentExecutionLease,
} from "./agent-execution-gate";
import {
  buildRevisionChangelogPage,
  diffRevisionMcpGrants,
  REVISION_CHANGELOG_PAGE_SIZE,
  revisionGrantsNewPermissions,
  type RevisionChangedField,
  type RevisionChangelogPage,
  type RevisionUpgradeDiff,
} from "@/lib/revisions/upgrade-diff";
import { stopSessionMcp } from "@/lib/process/session-mcp";
import { killProcess } from "@/lib/process/supervisor";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import { narrowExternalSandboxAccess } from "@/lib/sandboxes/external";
import { agentPermissionAdditions } from "./permission-additions";
import { TERMINAL } from "@/lib/a2a/model";
import { localTarget } from "@/lib/a2a/local-policy";

/** Only ingress contexts belonging to this exact session follow its explicit upgrade. */
async function conversationEntryContexts(
  tx: Prisma.TransactionClient,
  input: Scope,
  conversation: {
    id: string;
    sandboxId: string | null;
    workSession: { id: string } | null;
  },
  target: { id: string; version: number },
) {
  const contexts = await tx.a2AContext.findMany({
    where: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      targetKind: "local",
      entryBindings: {
        some: {
          OR: [
            {
              kind: { in: ["chat", "control", "channel", "trigger"] },
              sourceId: conversation.id,
            },
            ...(conversation.workSession
              ? [{ kind: "work", sourceId: conversation.workSession.id }]
              : []),
          ],
        },
      },
    },
    select: {
      id: true,
      agentRevisionId: true,
      legacyRevisionUnresolved: true,
      sandboxId: true,
      entryBindings: { select: { kind: true, sourceId: true } },
    },
  });
  for (const context of contexts) {
    if (
      context.legacyRevisionUnresolved ||
      !context.agentRevisionId ||
      (context.sandboxId && context.sandboxId !== conversation.sandboxId) ||
      context.entryBindings.some(
        (entry) =>
          !(
            (["chat", "control", "channel", "trigger"].includes(entry.kind) &&
              entry.sourceId === conversation.id) ||
            (entry.kind === "work" &&
              entry.sourceId === conversation.workSession?.id)
          ),
      )
    )
      throw new AgentConversationRevisionError("readOnly");
    const revision = await requireAgentRevision(
      tx,
      input.agentId,
      context.agentRevisionId,
    );
    if (revision.version > target.version)
      throw new AgentConversationRevisionError("targetRevisionNotCurrent");
  }
  if (contexts.length) {
    const roots = await tx.a2ATask.findMany({
      where: { contextId: { in: contexts.map(({ id }) => id) } },
      select: { id: true, rootTaskId: true },
    });
    if (
      await tx.a2ATask.count({
        where: {
          OR: [
            { contextId: { in: contexts.map(({ id }) => id) } },
            {
              rootTaskId: {
                in: [
                  ...new Set(
                    roots.map(({ id, rootTaskId }) => rootTaskId ?? id),
                  ),
                ],
              },
            },
          ],
          state: { notIn: TERMINAL },
        },
      })
    )
      throw new AgentConversationRevisionError("busy");
  }
  return contexts;
}

async function advanceConversationEntryContexts(
  tx: Prisma.TransactionClient,
  input: Scope,
  contexts: readonly { id: string }[],
  revisionId: string,
) {
  if (!contexts.length) return;
  const target = await localTarget(
    tx,
    input.workspaceId,
    input.agentId,
    "delegation",
    revisionId,
  );
  await tx.a2AContext.updateMany({
    where: {
      id: { in: contexts.map(({ id }) => id) },
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    },
    data: { agentRevisionId: revisionId, targetBinding: target.binding },
  });
}

export class AgentConversationRevisionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}

type Scope = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  targetVersion: number;
};
const equal = isDeepStrictEqual;

function diffSkills(
  from: AgentRevisionConfig["skills"],
  to: AgentRevisionConfig["skills"],
) {
  const before = new Map(from.map((skill) => [skill.installedSkillId, skill]));
  const after = new Map(to.map((skill) => [skill.installedSkillId, skill]));
  return {
    skillsAdded: to
      .filter((skill) => !before.has(skill.installedSkillId))
      .map((skill) => skill.name),
    skillsRemoved: from
      .filter((skill) => !after.has(skill.installedSkillId))
      .map((skill) => skill.name),
    skillsUpdated: to
      .filter((skill) => {
        const previous = before.get(skill.installedSkillId);
        return previous && !equal(previous, skill);
      })
      .map((skill) => skill.name),
  };
}

export function diffAgentRevisions(
  from: { version: number; config: AgentRevisionConfig },
  to: { version: number; config: AgentRevisionConfig },
  name: (id: string) => string | null = () => null,
): RevisionUpgradeDiff {
  const a = from.config,
    b = to.config;
  const fields: Array<[RevisionChangedField, unknown, unknown]> = [
    ["systemPrompt", a.systemPrompt, b.systemPrompt],
    [
      "model",
      [a.providerId, a.model, a.modelProviderIds, a.nativeRoleModels ?? []],
      [b.providerId, b.model, b.modelProviderIds, b.nativeRoleModels ?? []],
    ],
    ["maxSteps", a.maxSteps, b.maxSteps],
    ["reasoningEffort", a.reasoningEffort ?? null, b.reasoningEffort ?? null],
    ["packages", a.packages, b.packages],
    ["knowledge", a.knowledgeBaseIds, b.knowledgeBaseIds],
    [
      "environment",
      [
        a.sandboxTemplateId,
        a.environment,
        a.runtimeKind === "omp" ? a.ompConfigChecksum : null,
      ],
      [
        b.sandboxTemplateId,
        b.environment,
        b.runtimeKind === "omp" ? b.ompConfigChecksum : null,
      ],
    ],
    ["externalSandboxes", a.externalSandboxes, b.externalSandboxes],
    ["builtinTools", a.disabledBuiltinTools, b.disabledBuiltinTools],
    [
      "a2a",
      [
        a.a2a,
        a.subagentMode ?? "platform",
        a.subagentMode === "native" ? a.nativeSubagentPolicy : null,
      ],
      [
        b.a2a,
        b.subagentMode ?? "platform",
        b.subagentMode === "native" ? b.nativeSubagentPolicy : null,
      ],
    ],
  ];
  const mcp = diffRevisionMcpGrants(a.mcpGrants, b.mcpGrants, name);
  return {
    fromVersion: from.version,
    toVersion: to.version,
    changedFields: fields
      .filter(([, before, after]) => !equal(before, after))
      .map(([field]) => field),
    ...mcp,
    ...diffSkills(a.skills, b.skills),
    grantsNewPermissions:
      revisionGrantsNewPermissions(mcp) ||
      agentPermissionAdditions(a, b).some(
        (addition) => addition.kind === "delegation",
      ) ||
      (b.runtimeKind === "omp" &&
        (a.runtimeKind !== "omp" ||
          a.ompConfigChecksum !== b.ompConfigChecksum)) ||
      b.externalSandboxes.some((entry) => {
        const before = a.externalSandboxes.find(
          (item) => item.sandboxId === entry.sandboxId,
        );
        return (
          !before ||
          narrowExternalSandboxAccess(before.access, entry.access) !==
            entry.access
        );
      }),
  };
}

async function deploymentNames(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  configs: readonly AgentRevisionConfig[],
) {
  const deployments = await tx.deployment.findMany({
    where: {
      workspaceId,
      id: {
        in: [
          ...new Set(
            configs.flatMap((config) =>
              config.mcpGrants.map((grant) => grant.deploymentId),
            ),
          ),
        ],
      },
    },
    select: { id: true, name: true, server: { select: { name: true } } },
  });
  const names = new Map(
    deployments.map((row) => [row.id, row.name || row.server?.name || null]),
  );
  return (id: string) => names.get(id) ?? null;
}

/** Newest first; each entry compares a revision with the one published before it. */
export async function listAgentRevisionChangelog(input: {
  workspaceId: string;
  agentId: string;
  beforeVersion?: number;
}): Promise<RevisionChangelogPage> {
  const owner = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { currentRevisionVersion: true },
  });
  if (!owner) throw new AgentConversationRevisionError("notFound", 404);
  const rows = await db.agentRevision.findMany({
    where: {
      agentId: input.agentId,
      ...(input.beforeVersion ? { version: { lt: input.beforeVersion } } : {}),
    },
    orderBy: { version: "desc" },
    take: REVISION_CHANGELOG_PAGE_SIZE + 1,
    select: { version: true, config: true, createdAt: true },
  });
  const revisions = rows.map((row) => ({
    version: row.version,
    createdAt: row.createdAt,
    config: AgentRevisionConfigSchema.parse(row.config),
  }));
  const name = await deploymentNames(
    db,
    input.workspaceId,
    revisions.map((revision) => revision.config),
  );
  return buildRevisionChangelogPage(
    owner.currentRevisionVersion,
    revisions,
    (from, to) => diffAgentRevisions(from, to, name),
  );
}

async function load(tx: Prisma.TransactionClient, input: Scope) {
  const conversation = await tx.conversation.findFirst({
    where: {
      id: input.conversationId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    include: {
      workSession: true,
      publicApiConversation: { select: { id: true } },
      sandbox: { include: { deployment: true } },
    },
  });
  if (!conversation || conversation.publicApiConversation)
    throw new AgentConversationRevisionError("notFound", 404);
  const owner = await tx.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      workspace: { status: "active" },
    },
    select: {
      currentRevisionVersion: true,
      runtimeKind: true,
      retiredAt: true,
    },
  });
  if (!owner) throw new AgentConversationRevisionError("notFound", 404);
  const work = conversation.workSession;
  if (
    owner.runtimeKind !== "pi-sdk" ||
    owner.retiredAt ||
    conversation.legacyRevisionUnresolved ||
    !conversation.agentRevisionId ||
    (work &&
      (work.legacyRevisionUnresolved ||
        work.agentId !== input.agentId ||
        work.workspaceId !== input.workspaceId ||
        work.agentRevisionId !== conversation.agentRevisionId))
  )
    throw new AgentConversationRevisionError("readOnly");
  if (input.targetVersion !== owner.currentRevisionVersion)
    throw new AgentConversationRevisionError("targetRevisionNotCurrent");
  const from = await requireAgentRevision(
    tx,
    input.agentId,
    conversation.agentRevisionId,
  );
  const to = await requireAgentRevision(tx, input.agentId);
  if (to.version < from.version)
    throw new AgentConversationRevisionError("targetRevisionNotCurrent");
  return { conversation, from, to };
}

export async function getAgentConversationRevisionDiff(input: Scope) {
  return db.$transaction(async (tx) => {
    const { from, to } = await load(tx, input);
    const name = await deploymentNames(tx, input.workspaceId, [
      from.config,
      to.config,
    ]);
    return diffAgentRevisions(from, to, name);
  });
}

/** Advance the existing session and volume, never fork or replay its transcript. */
export async function upgradeAgentConversationRevision(
  input: Scope,
  onUpgraded?: (
    tx: Prisma.TransactionClient,
    result: { conversationId: string; version: number },
  ) => Promise<void>,
) {
  const initial = await load(db, input);
  const release = acquireConversationOperation(
    conversationOperationKey(initial.conversation),
    "revision",
  );
  if (!release) throw new AgentConversationRevisionError("busy");
  try {
    return await withAgentExecutionLease(
      { agentId: input.agentId, sessionId: input.conversationId, wait: false },
      async () => {
        const result = await db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${input.workspaceId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${input.agentId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${input.conversationId} AND "agentId" = ${input.agentId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM "WorkSession" WHERE "conversationId" = ${input.conversationId} FOR UPDATE`;
            const { conversation, from, to } = await load(tx, input);
            const shared = await tx.sandbox.findFirst({
              where: {
                workspaceId: input.workspaceId,
                AND: [
                  {
                    config: {
                      path: ["managedBy"],
                      equals: "agent-conversation",
                    },
                  },
                  { config: { path: ["agentId"], equals: input.agentId } },
                  { config: { path: ["scope"], equals: "agent" } },
                ],
              },
              select: { config: true },
            });
            if (shared) {
              const config = shared.config as Record<string, Prisma.JsonValue>;
              if (config.readOnly === true)
                throw new AgentConversationRevisionError("readOnly");
              if (
                Array.isArray(config.pendingWorkspaceDeletes) &&
                config.pendingWorkspaceDeletes.includes(conversation.id)
              )
                throw new AgentConversationRevisionError("busy");
              const pin =
                typeof config.agentRevisionId === "string"
                  ? await tx.agentRevision.findFirst({
                      where: {
                        id: config.agentRevisionId,
                        agentId: input.agentId,
                      },
                      select: { config: true },
                    })
                  : null;
              const environmentOwner =
                pin && AgentRevisionConfigSchema.parse(pin.config);
              if (
                !environmentOwner ||
                environmentOwner.runtimeKind !== to.config.runtimeKind ||
                !equal(environmentOwner.environment, to.config.environment)
              )
                throw new AgentConversationRevisionError(
                  "AGENT_SHARED_ENVIRONMENT_CONFLICT",
                );
            }
            const work = conversation.workSession;
            if (
              work &&
              ["queued", "running", "cancelling"].includes(work.status)
            )
              throw new AgentConversationRevisionError("busy");
            const contexts = await conversationEntryContexts(
              tx,
              input,
              conversation,
              to,
            );
            if (from.id === to.id) {
              // Repair earlier upgrades that advanced the Conversation but not its task context.
              await advanceConversationEntryContexts(
                tx,
                input,
                contexts,
                to.id,
              );
              await onUpgraded?.(tx, {
                conversationId: conversation.id,
                version: to.version,
              });
              return { conversationId: conversation.id, version: to.version };
            }
            const sandbox = conversation.sandbox;
            const environmentChanged = !equal(
              from.config.environment,
              to.config.environment,
            );
            if (sandbox) {
              const config =
                sandbox.config &&
                typeof sandbox.config === "object" &&
                !Array.isArray(sandbox.config)
                  ? sandbox.config
                  : {};
              if (
                config.readOnly === true ||
                config.managedBy !== "agent-conversation" ||
                config.agentId !== input.agentId
              )
                throw new AgentConversationRevisionError("readOnly");
              if (
                Array.isArray(config.pendingWorkspaceDeletes) &&
                config.pendingWorkspaceDeletes.includes(conversation.id)
              )
                throw new AgentConversationRevisionError("busy");
              // A conversation upgrade cannot change every other session's
              // image, network, limits, credentials or immutable seed snapshot.
              // Environment cutover requires an explicit Agent-wide decision.
              if (
                environmentChanged &&
                (config.scope === "agent" ||
                  !equal(
                    from.config.environment.initialSnapshot,
                    to.config.environment.initialSnapshot,
                  ))
              )
                throw new AgentConversationRevisionError(
                  "AGENT_SHARED_ENVIRONMENT_CONFLICT",
                );
              if (environmentChanged) assertRuntimeOwner();
              if (environmentChanged)
                await killProcess(sandbox.deploymentId, {
                  finalStatus: "stopped",
                });
              if (config.scope !== "agent")
                await tx.sandbox.update({
                  where: { id: sandbox.id },
                  data: {
                    config: {
                      ...config,
                      agentRevisionId: to.id,
                    } as Prisma.InputJsonValue,
                    image: to.config.environment.image,
                    network: to.config.environment.network,
                  },
                });
              if (environmentChanged) {
                const cfg = sandbox.deployment.installCfg;
                await tx.deployment.update({
                  where: { id: sandbox.deploymentId },
                  data: {
                    installCfg: {
                      ...(cfg && typeof cfg === "object" && !Array.isArray(cfg)
                        ? cfg
                        : {}),
                      image: to.config.environment.image,
                      network: to.config.environment.network,
                      resourceLimits: to.config.environment.resourceLimits,
                      ...("ompVersion" in to.config.environment
                        ? { ompVersion: to.config.environment.ompVersion }
                        : { piVersion: to.config.environment.piVersion }),
                    } as Prisma.InputJsonValue,
                  },
                });
              }
            }
            // Stop using the old, still-authorized pin before changing it. Volumes stay intact.
            if (from.config.mcpGrants.length)
              await stopSessionMcp({
                workspaceId: input.workspaceId,
                agentId: input.agentId,
                conversationId: input.conversationId,
                agentRevisionId: from.id,
              });
            if (!equal(from.config.packages, to.config.packages))
              await tx.piSessionPackageSet.deleteMany({
                where: { conversationId: conversation.id },
              });
            await tx.conversation.update({
              where: { id: conversation.id },
              data: { agentRevisionId: to.id },
            });
            if (work) {
              const session =
                to.config.runtimeKind === "pi-sdk"
                  ? await resolvePiSessionPackages(
                      {
                        workspaceId: input.workspaceId,
                        agentId: input.agentId,
                        conversationId: conversation.id,
                      },
                      tx,
                    )
                  : null;
              const snapshot =
                work.runtimeSnapshot &&
                typeof work.runtimeSnapshot === "object" &&
                !Array.isArray(work.runtimeSnapshot)
                  ? work.runtimeSnapshot
                  : {};
              await tx.workSession.update({
                where: { id: work.id },
                data: {
                  agentRevisionId: to.id,
                  runtimeSnapshot: {
                    ...snapshot,
                    agentRevisionId: to.id,
                    providerId: to.config.providerId,
                    model: to.config.model,
                    modelName: to.config.model,
                    contextWindow: null,
                    contextWindowEstimated: true,
                    systemPrompt: to.config.systemPrompt,
                    agentMaxSteps: to.config.maxSteps,
                    deploymentIds: to.config.mcpGrants.map(
                      (grant) => grant.deploymentId,
                    ),
                    installedSkillIds: to.config.skills.map(
                      (skill) => skill.installedSkillId,
                    ),
                    knowledgeBaseIds: to.config.knowledgeBaseIds,
                    ...(session
                      ? {
                          piPackages: session.packages.map(
                            ({
                              marketInstallId,
                              releaseId,
                              checksum,
                              mcpBindingsChecksum,
                            }) => ({
                              marketInstallId,
                              releaseId,
                              checksum,
                              ...(mcpBindingsChecksum
                                ? { mcpBindingsChecksum }
                                : {}),
                            }),
                          ),
                        }
                      : {}),
                  } as Prisma.InputJsonValue,
                },
              });
            }
            await advanceConversationEntryContexts(tx, input, contexts, to.id);
            await onUpgraded?.(tx, {
              conversationId: conversation.id,
              version: to.version,
            });
            return { conversationId: conversation.id, version: to.version };
          },
          { timeout: 30_000 },
        );
        return result;
      },
    );
  } catch (error) {
    if (error instanceof AgentExecutionBusyError)
      throw new AgentConversationRevisionError("busy");
    throw error;
  } finally {
    release();
  }
}

/**
 * Empty-state notice compares only the current and immediately preceding
 * publication, and is shown until a conversation runs on the current revision.
 */
export async function getAgentMcpToolsUpdated(
  workspaceId: string,
  agentId: string,
) {
  const owner = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { currentRevisionVersion: true },
  });
  if (!owner || owner.currentRevisionVersion < 2) return null;
  const revisions = await db.agentRevision.findMany({
    where: {
      agentId,
      version: {
        in: [owner.currentRevisionVersion - 1, owner.currentRevisionVersion],
      },
    },
    orderBy: { version: "asc" },
  });
  if (revisions.length !== 2) return null;
  if (
    await db.conversation.findFirst({
      where: { agentId, agentRevisionId: revisions[1].id },
      select: { id: true },
    })
  )
    return null;
  const configs = revisions.map((row) =>
    AgentRevisionConfigSchema.parse(row.config),
  );
  const name = await deploymentNames(db, workspaceId, configs);
  const diff = diffRevisionMcpGrants(
    configs[0].mcpGrants,
    configs[1].mcpGrants,
    name,
  );
  return {
    added: [...diff.mcpGrantsAdded, ...diff.mcpToolsAdded],
    removed: [...diff.mcpGrantsRemoved, ...diff.mcpToolsRemoved],
  };
}
