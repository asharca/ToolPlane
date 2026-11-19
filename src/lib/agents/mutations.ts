import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { deleteAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import { withAgentMaintenanceLease } from "@/lib/agents/agent-execution-gate";
import {
  normalizeDisabledBuiltinTools,
  type ExecutableAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";
import {
  getDefaultSandboxImage,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import {
  captureAgentRevisionConfig,
  publishAgentRevisionInTransaction,
} from "./revisions";
import { ensureWorkspaceMcpDeploymentPinned } from "@/lib/process/mcp-pinning";
import { prepareSessionMcpDefinition } from "@/lib/process/mcp-definition";
import { catalogToolNames } from "@/lib/process/mcp-grant-sync";
import { isExecutableAgentRuntimeKind } from "./runtime-kind";
import { preparePiRuntime } from "./pi-runtime";
import { parseOmpConfigSnapshot } from "./omp-config-server";
import { isOmpInstructionPath } from "./omp-config";
import {
  type AgentConfig,
  validateAndWritePiPackages,
  type AgentToolSelection,
  assertExactResources,
  assertRuntimeProviderFormat,
  validateExternalSandboxes,
  validateAdvisor,
  validatedOptionalBuiltinTools,
} from "./agent-draft-mutations";
import { AgentConfigurationError, uniqueIds } from "./agent-mutation-guards";
import { lockProvider } from "./provider-mutations";

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "agent";
}

async function lockAgentSlugNamespace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`agent-slug:${workspaceId}`}, 0)
    )::text AS "lock"
  `;
}

async function uniqueAgentSlug(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  let slug = baseSlug;
  for (
    let i = 1;
    await tx.agent.findFirst({ where: { workspaceId, slug } });
    i += 1
  ) {
    slug = `${baseSlug}-${i}`;
  }
  return slug;
}

export type CreateAgentOptions = {
  runtime?: ExecutableAgentRuntimeKind;
  piPackages?: AgentConfig["piPackages"];
  /** Template image for the Agent sandbox; defaults to the standard Node image. */
  sandboxImage?: string;
};

export type AgentCloneOptions = {
  copyMcp?: boolean;
  copySkills?: boolean;
  copyPiPackages?: boolean;
  copyConversations?: boolean;
};

async function uniqueSandboxSlug(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  baseSlug: string,
  suffix = "runtime",
): Promise<string> {
  let slug = `${baseSlug}-${suffix}`;
  for (
    let i = 1;
    await tx.sandbox.findFirst({ where: { workspaceId, slug } });
    i += 1
  ) {
    slug = `${baseSlug}-${suffix}-${i}`;
  }
  return slug;
}

async function createDedicatedSandboxRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agent: { id: string; name: string },
  sandboxSlug: string,
  image = getDefaultSandboxImage(),
) {
  const deployment = await tx.deployment.create({
    data: {
      workspaceId,
      name: `Sandbox: ${agent.name} Workspace`,
      source: "sandbox",
      sourceRef: image,
      status: "stopped",
    },
  });
  const sandbox = await tx.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: `${agent.name} Workspace`,
      slug: sandboxSlug,
      kind: "docker",
      image,
      network: "isolated",
      agentLinks: { create: { agentId: agent.id, isDefault: true } },
    },
  });
  await tx.deployment.update({
    where: { id: deployment.id },
    data: {
      installCfg: {
        sandboxId: sandbox.id,
        kind: "docker",
        image,
        network: "isolated",
        volumeName: sandboxVolumeName(sandbox.id),
        env: {},
        allowSudo: false,
      },
    },
  });
}

export async function createAgentRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  name: string,
  slug: string,
  options: CreateAgentOptions,
  sandboxSlug?: string,
) {
  const runtime = options.runtime ?? "pi-sdk";
  if (!isExecutableAgentRuntimeKind(runtime)) {
    throw new AgentConfigurationError("Only native Pi Agents can be created.");
  }
  const agent = await tx.agent.create({
    data: {
      workspaceId,
      name,
      slug,
      runtimeKind: runtime,
      optionalBuiltinTools: [],
      contextFiles: true,
      secretObfuscation: true,
    },
  });
  const templateSlug =
    sandboxSlug ??
    (await uniqueSandboxSlug(tx, workspaceId, slug, "workspace"));
  await createDedicatedSandboxRecords(
    tx,
    workspaceId,
    agent,
    templateSlug,
    options.sandboxImage,
  );
  return { ...agent, runtimeKind: runtime };
}

export async function createAgent(
  workspaceId: string,
  name: string,
  options: CreateAgentOptions = {},
) {
  const cleanName = name.trim() || "New agent";
  return db.$transaction(async (tx) => {
    if (options.piPackages !== undefined) {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    }
    await lockAgentSlugNamespace(tx, workspaceId);
    const slug = await uniqueAgentSlug(tx, workspaceId, slugify(cleanName));
    const sandboxSlug = await uniqueSandboxSlug(
      tx,
      workspaceId,
      slug,
      "workspace",
    );
    const agent = await createAgentRecords(
      tx,
      workspaceId,
      cleanName,
      slug,
      options,
      sandboxSlug,
    );
    await validateAndWritePiPackages(
      tx,
      workspaceId,
      agent.id,
      agent.runtimeKind,
      options.piPackages,
    );
    return agent;
  });
}

export async function cloneAgent(
  workspaceId: string,
  sourceAgentId: string,
  requestedName?: string,
  options?: AgentCloneOptions,
) {
  const sourceResources = await db.agent.findFirst({
    where: { id: sourceAgentId, workspaceId },
    select: {
      servers: { select: { deploymentId: true } },
      skills: { select: { installedSkillId: true } },
      piPackages: { select: { marketInstallId: true } },
    },
  });
  if (!sourceResources) return null;
  const deploymentIds = options?.copyMcp
    ? sourceResources.servers.map(({ deploymentId }) => deploymentId)
    : [];
  // Same-workspace bindings only; the copy is an unpublished draft that still
  // needs explicit revision review before it can execute.
  const deployments = await db.deployment.findMany({
    where: {
      id: { in: deploymentIds },
      workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    select: { id: true },
  });
  for (const { id } of deployments)
    await ensureWorkspaceMcpDeploymentPinned({ workspaceId, deploymentId: id });
  return db.$transaction(
    async (tx) => {
      const source = await tx.agent.findFirst({
        where: { id: sourceAgentId, workspaceId },
        select: {
          name: true,
          description: true,
          systemPrompt: true,
          runtimeKind: true,
          ompConfig: true,
          disabledBuiltinTools: true,
          maxSteps: true,
          reasoningEffort: true,
          streamRules: true,
          toolApproval: true,
          taskTimeoutSeconds: true,
          sandboxes: {
            where: { isDefault: true },
            select: { sandbox: { select: { image: true } } },
          },
        },
      });
      if (!source) return null;
      await lockAgentSlugNamespace(tx, workspaceId);
      const name = requestedName?.trim() || `${source.name} copy`;
      const slug = await uniqueAgentSlug(tx, workspaceId, slugify(name));
      const cloned = await createAgentRecords(tx, workspaceId, name, slug, {
        sandboxImage: source.sandboxes[0]?.sandbox.image ?? undefined,
      });
      await tx.agent.update({
        where: { id: cloned.id },
        data: {
          description: source.description,
          systemPrompt:
            [
              source.systemPrompt,
              ...(source.runtimeKind === "omp" && source.ompConfig
                ? parseOmpConfigSnapshot(source.ompConfig)
                    .files.filter((file) => isOmpInstructionPath(file.path))
                    .map((file) => file.content)
                : []),
            ]
              .filter(Boolean)
              .join("\n\n") || null,
          disabledBuiltinTools: normalizeDisabledBuiltinTools(
            "pi-sdk",
            source.disabledBuiltinTools,
          ),
          maxSteps: source.maxSteps,
          reasoningEffort: source.reasoningEffort,
          ...(source.streamRules != null
            ? { streamRules: source.streamRules as Prisma.InputJsonValue }
            : {}),
          ...(source.toolApproval ? { toolApproval: source.toolApproval } : {}),
          taskTimeoutSeconds: source.taskTimeoutSeconds,
        },
      });
      if (deployments.length) {
        const current = await tx.deployment.findMany({
          where: {
            id: { in: deployments.map(({ id }) => id) },
            workspaceId,
          },
          select: { id: true, installCfg: true },
        });
        await tx.agentServer.createMany({
          data: current.map(({ id, installCfg }) => ({
            agentId: cloned.id,
            deploymentId: id,
            allowedToolNames: catalogToolNames(installCfg),
          })),
        });
      }
      if (options?.copySkills && sourceResources.skills.length) {
        const skills = await tx.installedSkill.findMany({
          where: {
            id: {
              in: sourceResources.skills.map((s) => s.installedSkillId),
            },
            workspaceId,
          },
          select: { id: true },
        });
        await tx.agentSkill.createMany({
          data: skills.map(({ id }) => ({
            agentId: cloned.id,
            installedSkillId: id,
          })),
        });
      }
      if (options?.copyPiPackages && sourceResources.piPackages.length) {
        // Copies bind each plugin's current approved release, like a new Agent.
        await validateAndWritePiPackages(
          tx,
          workspaceId,
          cloned.id,
          cloned.runtimeKind,
          sourceResources.piPackages.map(({ marketInstallId }) => ({
            marketInstallId,
          })),
        );
      }
      const conversationIds = options?.copyConversations
        ? await cloneAgentConversationsInTransaction(
            tx,
            workspaceId,
            sourceAgentId,
            cloned.id,
          )
        : [];
      return { ...cloned, conversationIds, conversationsDeferred: false };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

export type AgentCloneConversationId = { sourceId: string; targetId: string };

type SourceConversationForClone = {
  id: string;
  title: string | null;
  reasoningEffort: string | null;
  createdAt: Date;
  messages: Array<{
    role: string;
    parts: Prisma.JsonValue;
    createdAt: Date;
  }>;
};

function copiedMessageParts(parts: Prisma.JsonValue) {
  // Prisma distinguishes JSON null from SQL NULL for required Json fields.
  // A historic message can legitimately contain the former.
  return parts === null ? Prisma.JsonNull : (parts as Prisma.InputJsonValue);
}

async function copyConversationsInTransaction(
  tx: Prisma.TransactionClient,
  targetAgentId: string,
  sourceConversations: ReadonlyArray<SourceConversationForClone>,
): Promise<AgentCloneConversationId[]> {
  const conversationIds: AgentCloneConversationId[] = [];
  for (const conversation of sourceConversations) {
    const copiedConversation = await tx.conversation.create({
      data: {
        agentId: targetAgentId,
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
        title: conversation.title,
        createdAt: conversation.createdAt,
        reasoningEffort: conversation.reasoningEffort,
      },
    });
    conversationIds.push({
      sourceId: conversation.id,
      targetId: copiedConversation.id,
    });
    if (conversation.messages.length > 0) {
      await tx.message.createMany({
        data: conversation.messages.map((message) => ({
          conversationId: copiedConversation.id,
          role: message.role,
          parts: copiedMessageParts(message.parts),
          createdAt: message.createdAt,
        })),
      });
    }
  }
  return conversationIds;
}

async function cloneAgentConversationsInTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
): Promise<AgentCloneConversationId[]> {
  const [source, target] = await Promise.all([
    tx.agent.findFirst({
      where: { id: sourceAgentId, workspaceId },
      select: {
        conversations: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            title: true,
            reasoningEffort: true,
            createdAt: true,
            messages: {
              orderBy: { createdAt: "asc" },
              select: { role: true, parts: true, createdAt: true },
            },
          },
        },
      },
    }),
    tx.agent.findFirst({
      where: { id: targetAgentId, workspaceId },
      select: { id: true },
    }),
  ]);
  if (!source || !target)
    throw new Error("The source or target agent is no longer available.");
  return copyConversationsInTransaction(tx, target.id, source.conversations);
}

// Creates the Agent record, its model configuration, and all bindings in one
// transaction. This is the safe write primitive for API/MCP callers: unlike
// the forgiving dashboard mutations, a foreign or stale resource ID aborts
// the whole operation instead of being silently dropped.
export async function createConfiguredAgent(
  workspaceId: string,
  cfg: AgentConfig,
  tools: AgentToolSelection,
  options: CreateAgentOptions & {
    enable?: boolean;
    authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
) {
  const runtime = options.runtime ?? "pi-sdk";
  if (!isExecutableAgentRuntimeKind(runtime)) {
    throw new AgentConfigurationError("Only native Pi Agents can be created.");
  }
  const cleanName = cfg.name.trim() || "New agent";
  const deploymentIds = uniqueIds(tools.deploymentIds);
  const installedSkillIds = uniqueIds(tools.installedSkillIds);
  const toolkitIds = uniqueIds(tools.toolkitIds);

  const selectedDeployments = await db.deployment.findMany({
    where: {
      id: { in: deploymentIds },
      workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    select: { id: true },
  });
  assertExactResources("MCP deployment", deploymentIds, selectedDeployments);
  for (const { id } of selectedDeployments) {
    const deployment = await ensureWorkspaceMcpDeploymentPinned({
      workspaceId,
      deploymentId: id,
    });
    if (options.enable) await prepareSessionMcpDefinition(deployment);
  }
  // Finish network preparation before taking transactional locks or exposing a usable Agent.
  if (options.enable && runtime === "pi-sdk") await preparePiRuntime();
  return await db.$transaction(
    async (tx) => {
      await options.authorize?.(tx);
      if (options.piPackages !== undefined || cfg.piPackages !== undefined) {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      }
      await lockAgentSlugNamespace(tx, workspaceId);
      const slug = await uniqueAgentSlug(tx, workspaceId, slugify(cleanName));
      const sandboxSlug = await uniqueSandboxSlug(
        tx,
        workspaceId,
        slug,
        "workspace",
      );
      if (cfg.model && !cfg.providerId) {
        throw new AgentConfigurationError("A model requires a model provider.");
      }
      if (cfg.providerId) {
        const provider = await lockProvider(tx, workspaceId, cfg.providerId);
        if (!provider)
          throw new AgentConfigurationError(
            `Unknown model provider: ${cfg.providerId}`,
          );
        assertRuntimeProviderFormat(runtime, provider.format);
        if (cfg.model && !provider.models.includes(cfg.model)) {
          throw new AgentConfigurationError(
            `Unknown or unavailable model: ${cfg.model}`,
          );
        }
      }
      await validateAdvisor(tx, workspaceId, cfg.advisor);

      // Interactive transactions use one pg connection; keep these awaits
      // sequential so the adapter never issues overlapping client.query calls.
      const deployments = await tx.deployment.findMany({
        where: {
          id: { in: deploymentIds },
          workspaceId,
          OR: [{ source: null }, { source: { not: "sandbox" } }],
        },
        select: { id: true, installCfg: true },
      });
      const skills = await tx.installedSkill.findMany({
        where: { id: { in: installedSkillIds }, workspaceId },
        select: { id: true },
      });
      const toolkits = await tx.toolkit.findMany({
        where: { id: { in: toolkitIds }, workspaceId },
        select: { id: true },
      });
      const externalSandboxes = await validateExternalSandboxes(
        tx,
        workspaceId,
        tools.externalSandboxes ?? [],
      );
      assertExactResources("MCP deployment", deploymentIds, deployments);
      assertExactResources("installed skill", installedSkillIds, skills);
      assertExactResources("toolkit", toolkitIds, toolkits);

      const agent = await createAgentRecords(
        tx,
        workspaceId,
        cleanName,
        slug,
        options,
        sandboxSlug,
      );
      await tx.agent.update({
        where: { id: agent.id },
        data: {
          name: cleanName,
          description: cfg.description?.trim() || null,
          systemPrompt: cfg.systemPrompt,
          contextFiles: cfg.contextFiles ?? true,
          providerId: cfg.providerId,
          model: cfg.providerId ? cfg.model : null,
          disabledBuiltinTools: normalizeDisabledBuiltinTools(
            runtime,
            cfg.disabledBuiltinTools,
          ),
          optionalBuiltinTools: validatedOptionalBuiltinTools(
            cfg.optionalBuiltinTools,
          ),
          maxSteps: cfg.maxSteps,
          reasoningEffort: cfg.reasoningEffort ?? null,
          toolApproval: cfg.toolApproval ?? { mode: "off" },
          secretObfuscation: cfg.secretObfuscation ?? true,
          taskTimeoutSeconds: cfg.taskTimeoutSeconds ?? null,
          ...(cfg.advisor ? { advisor: cfg.advisor } : {}),
        },
      });
      await tx.agentServer.createMany({
        data: deployments.map(({ id, installCfg }) => ({
          agentId: agent.id,
          deploymentId: id,
          allowedToolNames: catalogToolNames(installCfg),
        })),
      });
      await tx.agentSkill.createMany({
        data: skills.map(({ id }) => ({
          agentId: agent.id,
          installedSkillId: id,
        })),
      });
      await tx.agentToolkit.createMany({
        data: toolkits.map(({ id }) => ({
          agentId: agent.id,
          toolkitId: id,
        })),
      });
      await tx.agentExternalSandbox.createMany({
        data: externalSandboxes.map(({ sandboxId, access }) => ({
          agentId: agent.id,
          sandboxId,
          access,
        })),
      });
      await validateAndWritePiPackages(
        tx,
        workspaceId,
        agent.id,
        runtime,
        options.piPackages ?? cfg.piPackages,
      );
      if (options.enable) {
        const config = await captureAgentRevisionConfig(tx, agent.id);
        await publishAgentRevisionInTransaction(tx, workspaceId, agent.id, {
          expectedRevisionId: null,
          config,
        });
      }
      await options.authorize?.(tx);
      return agent;
    },
    { maxWait: 10_000, timeout: options.enable ? 120_000 : 30_000 },
  );
}

export async function getAgentDeleteTargets(
  workspaceId: string,
  agentId: string,
) {
  const deletableAgents = await db.agent.findMany({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      sandboxes: {
        select: {
          sandbox: {
            select: {
              id: true,
              kind: true,
              deploymentId: true,
              deployment: { select: { installCfg: true } },
              snapshots: { select: { volumeName: true } },
            },
          },
        },
      },
    },
  });
  const sandboxes = new Map<
    string,
    {
      id: string;
      kind: string;
      deploymentId: string;
      volumeName: string;
      snapshotVolumeNames: string[];
    }
  >();
  for (const candidate of deletableAgents.flatMap((row) =>
    row.sandboxes.map(({ sandbox }) => sandbox),
  )) {
    const config = candidate.deployment.installCfg;
    const volumeName =
      config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      typeof (config as Record<string, unknown>).volumeName === "string"
        ? String((config as Record<string, unknown>).volumeName)
        : sandboxVolumeName(candidate.id);
    sandboxes.set(candidate.id, {
      id: candidate.id,
      kind: candidate.kind,
      deploymentId: candidate.deploymentId,
      volumeName,
      snapshotVolumeNames: candidate.snapshots.map(
        ({ volumeName: name }) => name,
      ),
    });
  }
  return {
    agentIds: deletableAgents.map(({ id }) => id),
    sandboxes: [...sandboxes.values()],
  };
}

export async function deleteAgent(
  workspaceId: string,
  agentId: string,
  beforeDelete?: () => Promise<void>,
) {
  const targets = await getAgentDeleteTargets(workspaceId, agentId);
  const agentIds = [...new Set([agentId, ...targets.agentIds])].sort();
  const remove = async (index: number): Promise<void> => {
    const target = agentIds[index];
    if (target) {
      await withAgentMaintenanceLease(target, () => remove(index + 1));
      return;
    }
    for (const targetId of agentIds)
      await deleteAgentConversationSandboxes({
        workspaceId,
        agentId: targetId,
      });
    await beforeDelete?.();
    await deleteAgentRecords(workspaceId, agentId);
  };
  await remove(0);
}

async function deleteAgentRecords(workspaceId: string, agentId: string) {
  const sandboxes = await db.sandbox.findMany({
    where: { workspaceId, agentLinks: { some: { agentId } } },
    select: { deploymentId: true },
  });
  const sandboxDeploymentIds = sandboxes.map(
    ({ deploymentId }) => deploymentId,
  );
  await db.$transaction(async (tx) => {
    if (sandboxDeploymentIds.length > 0) {
      await tx.deployment.deleteMany({
        where: {
          id: { in: [...new Set(sandboxDeploymentIds)] },
          workspaceId,
          source: "sandbox",
        },
      });
    }
    await tx.agent.deleteMany({ where: { id: agentId, workspaceId } });
  });
}
