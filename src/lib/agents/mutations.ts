import "server-only";
import type { ReasoningLevel } from "./constants";
import { selectNewSessionRevision } from "@/lib/agents/evolution/rollout-selection";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { visiblePluginWhere } from "@/lib/plugins/catalog";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { deleteAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import {
  withAgentDraftLease,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";
import { writeAudit } from "@/lib/observability/audit";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import {
  defaultProviderModel,
  fillProviderModelMetadata,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  normalizeDisabledBuiltinTools,
  type ImplementedAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import {
  type ExternalSandboxAccess,
  isExternalSandboxAccess,
  isExternalSandboxCandidate,
  MAX_EXTERNAL_SANDBOXES,
} from "@/lib/sandboxes/external";
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

function assertNativeAgent(runtimeKind: string, retiredAt: Date | null): void {
  if (!isExecutableAgentRuntimeKind(runtimeKind) || retiredAt !== null) {
    throw new AgentConfigurationError(
      "Historical Agents are read-only; copy configuration to a native Pi Agent.",
    );
  }
}

/** Validated outside the write so a rejected selection never touches existing rows. */
async function validateExternalSandboxes(
  client: Prisma.TransactionClient,
  workspaceId: string,
  requested: readonly ExternalSandboxSelection[],
): Promise<ExternalSandboxSelection[]> {
  if (requested.length > MAX_EXTERNAL_SANDBOXES)
    throw new AgentConfigurationError(
      `An Agent can attach at most ${MAX_EXTERNAL_SANDBOXES} external sandboxes.`,
    );
  const ids = new Set<string>();
  for (const entry of requested) {
    if (
      typeof entry.sandboxId !== "string" ||
      !entry.sandboxId ||
      ids.has(entry.sandboxId) ||
      !isExternalSandboxAccess(entry.access)
    )
      throw new AgentConfigurationError("Invalid external sandbox selection.");
    ids.add(entry.sandboxId);
  }
  const rows = await client.sandbox.findMany({
    where: { id: { in: [...ids] }, workspaceId },
    select: {
      id: true,
      kind: true,
      config: true,
      _count: { select: { agentLinks: true } },
    },
  });
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (
      !row ||
      !isExternalSandboxCandidate({
        kind: row.kind,
        config: row.config,
        isAgentTemplate: row._count.agentLinks > 0,
      })
    )
      throw new AgentConfigurationError(
        "Only SSH, connector or standalone Docker sandboxes in this workspace can be attached.",
      );
  }
  return requested.map(({ sandboxId, access }) => ({ sandboxId, access }));
}

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
  runtime?: ImplementedAgentRuntimeKind;
  piPackages?: AgentConfig["piPackages"];
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
) {
  const deployment = await tx.deployment.create({
    data: {
      workspaceId,
      name: `Sandbox: ${agent.name} Workspace`,
      source: "sandbox",
      sourceRef: DEFAULT_SANDBOX_IMAGE,
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
      image: DEFAULT_SANDBOX_IMAGE,
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
        image: DEFAULT_SANDBOX_IMAGE,
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
    },
  });
  const templateSlug =
    sandboxSlug ??
    (await uniqueSandboxSlug(tx, workspaceId, slug, "workspace"));
  await createDedicatedSandboxRecords(tx, workspaceId, agent, templateSlug);
  return agent;
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
        },
      });
      if (!source) return null;
      await lockAgentSlugNamespace(tx, workspaceId);
      const name = requestedName?.trim() || `${source.name} copy`;
      const slug = await uniqueAgentSlug(tx, workspaceId, slugify(name));
      const cloned = await createAgentRecords(tx, workspaceId, name, slug, {});
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

export type AgentConfig = {
  name: string;
  description?: string | null;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
  disabledBuiltinTools?: string[];
  maxSteps: number;
  reasoningEffort?: ReasoningLevel | null;
  piPackages?: Array<{ marketInstallId: string; releaseId?: string }>;
};

export type ExternalSandboxSelection = {
  sandboxId: string;
  access: ExternalSandboxAccess;
};

export type AgentToolSelection = {
  deploymentIds: string[];
  installedSkillIds: string[];
  toolkitIds: string[];
  /** Full desired set; omit to keep current attachments. */
  externalSandboxes?: ExternalSandboxSelection[];
};

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}

async function validateAndWritePiPackages(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  runtimeKind: string,
  piPackages: AgentConfig["piPackages"],
) {
  if (piPackages === undefined) return; // undefined = no change
  if (runtimeKind !== "pi-sdk")
    throw new AgentConfigurationError("pi_packages_runtime_unsupported");
  if (
    !Array.isArray(piPackages) ||
    piPackages.some(
      (pkg) =>
        !pkg ||
        typeof pkg !== "object" ||
        Object.keys(pkg).some(
          (key) => key !== "marketInstallId" && key !== "releaseId",
        ) ||
        typeof pkg.marketInstallId !== "string" ||
        !pkg.marketInstallId ||
        (pkg.releaseId !== undefined &&
          (typeof pkg.releaseId !== "string" || !pkg.releaseId)),
    )
  ) {
    throw new AgentConfigurationError("pi_packages_invalid");
  }
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
  if (piPackages.length > 16)
    throw new AgentConfigurationError("Too many Pi packages (max 16).");
  const seenInstalls = new Set<string>();
  for (const pkg of piPackages) {
    if (seenInstalls.has(pkg.marketInstallId))
      throw new AgentConfigurationError(
        `Duplicate marketInstallId: ${pkg.marketInstallId}`,
      );
    seenInstalls.add(pkg.marketInstallId);
  }
  const existing = await tx.agentPiPackage.findMany({
    where: { agentId, agent: { workspaceId } },
  });
  const pins: Array<{ marketInstallId: string; releaseId: string }> = [];
  for (const pkg of piPackages) {
    const install = await tx.marketInstall.findFirst({
      where: {
        id: pkg.marketInstallId,
        targetWorkspaceId: workspaceId,
        listing: { ...visiblePluginWhere(workspaceId), status: "published" },
      },
      select: {
        id: true,
        listingId: true,
        status: true,
        currentReleaseId: true,
      },
    });
    if (!install)
      throw new AgentConfigurationError(
        `Unknown or inaccessible market install: ${pkg.marketInstallId}`,
      );
    if (install.status !== "ready")
      throw new AgentConfigurationError(
        `Market install is not ready: ${pkg.marketInstallId}`,
      );
    const retained = existing.find(
      (bound) => bound.marketInstallId === pkg.marketInstallId,
    );
    const releaseId =
      retained &&
      (pkg.releaseId === undefined || pkg.releaseId === retained.releaseId)
        ? retained.releaseId
        : install.currentReleaseId;
    if (pkg.releaseId !== undefined && pkg.releaseId !== releaseId)
      throw new AgentConfigurationError(
        `Release not approved: ${pkg.releaseId}`,
      );
    const release = await tx.marketRelease.findFirst({
      where: {
        id: releaseId,
        listingId: install.listingId,
        reviewStatus: "approved",
      },
      select: { id: true, manifest: true, checksum: true },
    });
    if (!release)
      throw new AgentConfigurationError(`Release not approved: ${releaseId}`);
    if (
      parsePiPackageReleaseManifest(release.manifest, release.checksum).package
        .runtime.kind !== runtimeKind
    )
      throw new AgentConfigurationError("PLUGIN_RUNTIME_MISMATCH");
    pins.push({ marketInstallId: pkg.marketInstallId, releaseId });
  }
  if (
    existing.length === pins.length &&
    existing.every((bound) =>
      pins.some(
        (pin) =>
          pin.marketInstallId === bound.marketInstallId &&
          pin.releaseId === bound.releaseId,
      ),
    )
  )
    return;
  await tx.agentPiPackage.deleteMany({
    where: {
      agentId,
      agent: { workspaceId },
      marketInstallId: { notIn: pins.map((pin) => pin.marketInstallId) },
    },
  });
  for (const pin of pins) {
    const retained = existing.find(
      (bound) => bound.marketInstallId === pin.marketInstallId,
    );
    if (retained?.releaseId === pin.releaseId) continue;
    await tx.agentPiPackage.upsert({
      where: {
        agentId_marketInstallId: {
          agentId,
          marketInstallId: pin.marketInstallId,
        },
      },
      create: { agentId, ...pin },
      update: {
        releaseId: pin.releaseId,
        syncStatus: "synced",
        targetReleaseId: null,
        syncRequestedById: null,
        syncError: null,
      },
    });
  }
}

export async function setAgentPiPackages(
  workspaceId: string,
  agentId: string,
  piPackages: NonNullable<AgentConfig["piPackages"]>,
) {
  return withAgentDraftLease(agentId, () =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      const agent = await tx.agent.findFirst({
        where: {
          id: agentId,
          workspaceId,
          runtimeKind: "pi-sdk",
          publicRuntimeAllocation: null,
          workspace: { status: "active" },
        },
        select: { runtimeKind: true },
      });
      if (!agent) throw new AgentConfigurationError("pi_package_unavailable");
      await validateAndWritePiPackages(
        tx,
        workspaceId,
        agentId,
        agent.runtimeKind,
        piPackages,
      );
    }),
  );
}

async function requireAgentWorkspaceResource(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  resource: { kind: "skill" | "mcp"; id: string },
) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
  const agent = await tx.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      runtimeKind: "pi-sdk",
      publicRuntimeAllocation: null,
      workspace: { status: "active" },
    },
    select: { id: true },
  });
  if (!agent) throw new AgentConfigurationError("resource_binding_unavailable");
  const selected =
    resource.kind === "skill"
      ? await tx.installedSkill.findFirst({
          where: { id: resource.id, workspaceId },
        })
      : await tx.deployment.findFirst({
          where: {
            id: resource.id,
            workspaceId,
            OR: [{ source: null }, { source: { not: "sandbox" } }],
          },
        });
  if (!selected)
    throw new AgentConfigurationError("resource_binding_unavailable");
}

export async function bindAgentWorkspaceResource(
  workspaceId: string,
  agentId: string,
  resource: { kind: "skill" | "mcp"; id: string },
) {
  // Draft bindings only shape the next revision; pinned sessions keep running.
  return withAgentDraftLease(agentId, async () => {
    if (resource.kind === "mcp") {
      await db.$transaction((tx) =>
        requireAgentWorkspaceResource(tx, workspaceId, agentId, resource),
      );
      await ensureWorkspaceMcpDeploymentPinned({
        workspaceId,
        deploymentId: resource.id,
      });
    }
    return db.$transaction(async (tx) => {
      // Recheck ownership after metadata resolution, before attaching.
      await requireAgentWorkspaceResource(tx, workspaceId, agentId, resource);
      if (resource.kind === "skill") {
        await tx.agentSkill.upsert({
          where: {
            agentId_installedSkillId: {
              agentId,
              installedSkillId: resource.id,
            },
          },
          create: { agentId, installedSkillId: resource.id },
          update: {},
        });
      } else {
        const deployment = await tx.deployment.findUniqueOrThrow({
          where: { id: resource.id },
        });
        await tx.agentServer.upsert({
          where: {
            agentId_deploymentId: { agentId, deploymentId: resource.id },
          },
          create: {
            agentId,
            deploymentId: resource.id,
            allowedToolNames: catalogToolNames(deployment.installCfg),
          },
          update: { allowedToolNames: catalogToolNames(deployment.installCfg) },
        });
      }
    });
  });
}

function assertRuntimeProviderFormat(runtime: string, format: string) {
  if (!agentRuntimeSupportsProviderFormat(runtime, format)) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} does not support provider format "${format}".`,
    );
  }
}

type LockedModelProvider = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  models: string[];
};

async function lockProvider(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  providerId: string,
): Promise<LockedModelProvider | null> {
  const providers = await tx.$queryRaw<LockedModelProvider[]>`
    SELECT "id", "name", "format", "baseUrl", "models"
    FROM "ModelProvider"
    WHERE "id" = ${providerId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE
  `;
  return providers[0] ?? null;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}
export async function validateNativeModelSelection(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runtimeKind: string,
  selectedProviderId: string | null | undefined,
  model: string | null,
): Promise<string | null> {
  const selected = selectedProviderId
    ? await lockProvider(tx, workspaceId, selectedProviderId)
    : null;
  if (selected) {
    assertRuntimeProviderFormat(runtimeKind, selected.format);
    if (model && !selected.models.includes(model))
      throw new AgentConfigurationError(
        `Unknown or unavailable model: ${model}`,
      );
  }
  return selected?.id ?? null;
}

function assertExactResources(
  label: string,
  requestedIds: readonly string[],
  rows: readonly { id: string }[],
) {
  const found = new Set(rows.map(({ id }) => id));
  const missing = requestedIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AgentConfigurationError(
      `Unknown or unavailable ${label}: ${missing.join(", ")}`,
    );
  }
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
          providerId: cfg.providerId,
          model: cfg.providerId ? cfg.model : null,
          disabledBuiltinTools: normalizeDisabledBuiltinTools(
            runtime,
            cfg.disabledBuiltinTools,
          ),
          maxSteps: cfg.maxSteps,
          reasoningEffort: cfg.reasoningEffort ?? null,
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

export async function updateAgent(
  workspaceId: string,
  agentId: string,
  cfg: AgentConfig,
) {
  return withAgentDraftLease(agentId, async () => {
    await db.$transaction(async (tx) => {
      if (cfg.piPackages !== undefined) {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      }
      const agent = await tx.agent.findFirst({
        where: { id: agentId, workspaceId },
        select: {
          id: true,
          runtimeKind: true,
          retiredAt: true,
        },
      });
      if (!agent) return;
      assertNativeAgent(agent.runtimeKind, agent.retiredAt);

      const providerId = await validateNativeModelSelection(
        tx,
        workspaceId,
        agent.runtimeKind,
        cfg.providerId,
        cfg.model,
      );
      await tx.agent.updateMany({
        where: { id: agentId, workspaceId },
        data: {
          name: cfg.name,
          ...(cfg.description === undefined
            ? {}
            : { description: cfg.description?.trim() || null }),
          systemPrompt: cfg.systemPrompt,
          providerId,
          model: providerId ? cfg.model : null,
          ...(cfg.disabledBuiltinTools === undefined
            ? {}
            : {
                disabledBuiltinTools: normalizeDisabledBuiltinTools(
                  agent.runtimeKind,
                  cfg.disabledBuiltinTools,
                ),
              }),
          maxSteps: cfg.maxSteps,
          ...(cfg.reasoningEffort !== undefined
            ? { reasoningEffort: cfg.reasoningEffort }
            : {}),
        },
      });
      await validateAndWritePiPackages(
        tx,
        workspaceId,
        agentId,
        agent.runtimeKind,
        cfg.piPackages,
      );
    });
  });
}

export async function updateAgentModelSelection(
  workspaceId: string,
  agentId: string,
  providerId: string | null,
  model: string | null,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: {
        id: true,
        runtimeKind: true,
        retiredAt: true,
      },
    });
    if (!agent) return;
    assertNativeAgent(agent.runtimeKind, agent.retiredAt);

    const validProviderId = await validateNativeModelSelection(
      tx,
      workspaceId,
      agent.runtimeKind,
      providerId,
      model,
    );
    await tx.agent.updateMany({
      where: { id: agentId, workspaceId },
      data: {
        providerId: validProviderId,
        model: validProviderId ? model : null,
      },
    });
    return agent.runtimeKind;
  });
}

export async function setAgentTools(
  workspaceId: string,
  agentId: string,
  tools: AgentToolSelection,
) {
  return withAgentDraftLease(agentId, async () => {
    const agent = await db.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true, runtimeKind: true, retiredAt: true },
    });
    if (!agent) return;
    assertNativeAgent(agent.runtimeKind, agent.retiredAt);
    // The Agent's own sandbox is fixed at creation; only attachments change here.
    const externalSandboxes =
      tools.externalSandboxes &&
      (await validateExternalSandboxes(
        db,
        workspaceId,
        tools.externalSandboxes,
      ));
    const [deployments, skills, toolkits] = await Promise.all([
      db.deployment.findMany({
        where: {
          id: { in: tools.deploymentIds },
          workspaceId,
          OR: [{ source: null }, { source: { not: "sandbox" } }],
        },
        select: { id: true, installCfg: true },
      }),
      db.installedSkill.findMany({
        where: { id: { in: tools.installedSkillIds }, workspaceId },
        select: { id: true },
      }),
      db.toolkit.findMany({
        where: { id: { in: tools.toolkitIds }, workspaceId },
        select: { id: true },
      }),
    ]);
    for (const { id } of deployments)
      await ensureWorkspaceMcpDeploymentPinned({
        workspaceId,
        deploymentId: id,
      });
    await db.$transaction([
      db.agentServer.deleteMany({
        where: {
          agentId,
          deploymentId: { notIn: deployments.map(({ id }) => id) },
        },
      }),
      db.agentSkill.deleteMany({ where: { agentId } }),
      db.agentToolkit.deleteMany({ where: { agentId } }),
      ...(externalSandboxes
        ? [
            db.agentExternalSandbox.deleteMany({ where: { agentId } }),
            db.agentExternalSandbox.createMany({
              data: externalSandboxes.map(({ sandboxId, access }) => ({
                agentId,
                sandboxId,
                access,
              })),
            }),
          ]
        : []),
      ...deployments.map((deployment) => {
        const data = {
          allowedToolNames: catalogToolNames(deployment.installCfg),
        };
        return db.agentServer.upsert({
          where: {
            agentId_deploymentId: { agentId, deploymentId: deployment.id },
          },
          create: { agentId, deploymentId: deployment.id, ...data },
          update: data,
        });
      }),
      db.agentSkill.createMany({
        data: skills.map((s) => ({ agentId, installedSkillId: s.id })),
      }),
      db.agentToolkit.createMany({
        data: toolkits.map((t) => ({ agentId, toolkitId: t.id })),
      }),
    ]);
  });
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

export async function createProvider(
  workspaceId: string,
  data: { name: string; format: string; baseUrl: string; apiKey: string },
  actorId = "system",
) {
  return db.$transaction(async (tx) => {
    const provider = await tx.modelProvider.create({
      data: { workspaceId, ...data },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.created",
      targetType: "modelProvider",
      targetId: provider.id,
      changes: {
        name: data.name,
        format: data.format,
        baseUrl: data.baseUrl,
        credentialChanged: true,
      },
    });
    return provider;
  });
}

export async function updateProvider(
  workspaceId: string,
  providerId: string,
  data: { name: string; format: string; baseUrl: string; apiKey?: string },
  actorId = "system",
) {
  await db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) return;
    const before = await tx.modelProvider.findFirst({
      where: { id: providerId, workspaceId },
      select: { name: true, format: true, baseUrl: true },
    });
    await tx.modelProvider.updateMany({
      where: { id: providerId, workspaceId },
      data,
    });
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.changed",
      targetType: "modelProvider",
      targetId: providerId,
      changes: {
        before,
        after: { name: data.name, format: data.format, baseUrl: data.baseUrl },
        credentialChanged: data.apiKey !== undefined,
      },
    });
  });
}

export async function deleteProvider(
  workspaceId: string,
  providerId: string,
  actorId = "system",
) {
  return db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) return;

    await tx.agent.updateMany({
      where: { workspaceId, providerId },
      data: { providerId: null, model: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, defaultModelProviderId: providerId },
      data: { defaultModelProviderId: null, defaultModel: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, titleModelProviderId: providerId },
      data: { titleModelProviderId: null, titleModel: null },
    });
    await tx.modelProvider.deleteMany({
      where: { id: providerId, workspaceId },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId,
      action: "provider.deleted",
      targetType: "modelProvider",
      targetId: providerId,
    });
  });
}

function providerModelData(model: ProviderModelValues) {
  return {
    ...model,
    cost: model.cost
      ? (model.cost as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull,
  };
}

async function fillStoredProviderModels(
  tx: Prisma.TransactionClient,
  provider: {
    id: string;
    name: string;
    format: string;
    baseUrl: string;
    models: string[];
  },
) {
  const records = await tx.providerModel.findMany({
    where: { providerId: provider.id },
    select: {
      modelId: true,
      name: true,
      group: true,
      primaryType: true,
      source: true,
      capabilities: true,
      inputModalities: true,
      contextWindow: true,
      maxInputTokens: true,
      maxOutputTokens: true,
      cost: true,
    },
  });
  const storedIds = new Set(records.map(({ modelId }) => modelId));
  const missing = uniqueIds(provider.models).filter(
    (modelId) => !storedIds.has(modelId),
  );
  if (missing.length) {
    await tx.providerModel.createMany({
      data: missing.map((modelId) => ({
        ...providerModelData(
          fillProviderModelMetadata(
            defaultProviderModel(modelId),
            matchingPiModelReferences(
              provider.format,
              [modelId],
              provider.baseUrl,
              provider.name,
            )[0] ?? null,
          ),
        ),
        providerId: provider.id,
        source: "remote",
      })),
    });
  }
  for (const record of records) {
    const { source, ...model } = record as ProviderModelValues & {
      source: string;
    };
    const reference =
      matchingPiModelReferences(
        provider.format,
        [model.modelId, model.name],
        provider.baseUrl,
        provider.name,
      )[0] ?? null;
    const filled = fillProviderModelMetadata(
      source === "remote" && reference
        ? {
            ...model,
            contextWindow: reference.contextWindow,
            maxOutputTokens: reference.maxOutputTokens,
            cost: reference.cost,
          }
        : model,
      reference,
    );
    const data = Object.fromEntries(
      Object.entries(filled).filter(
        ([key, value]) => value !== model[key as keyof ProviderModelValues],
      ),
    ) as Prisma.ProviderModelUpdateInput;
    if (Object.keys(data).length) {
      await tx.providerModel.update({
        where: {
          providerId_modelId: {
            providerId: provider.id,
            modelId: model.modelId,
          },
        },
        data,
      });
    }
  }
}

export async function backfillProviderModels(workspaceId: string) {
  const providers = await db.modelProvider.findMany({
    where: { workspaceId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id } of providers) {
    await db.$transaction(async (tx) => {
      const provider = await lockProvider(tx, workspaceId, id);
      if (provider) await fillStoredProviderModels(tx, provider);
    });
  }
}

export async function setProviderModels(
  workspaceId: string,
  providerId: string,
  models: string[],
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) return;
    const remoteModelIds = uniqueIds(
      models.map((model) => model.trim()).filter(Boolean),
    );
    await tx.providerModel.deleteMany({
      where: {
        providerId,
        source: "remote",
        ...(remoteModelIds.length
          ? { modelId: { notIn: remoteModelIds } }
          : {}),
      },
    });
    const manualModels = await tx.providerModel.findMany({
      where: { providerId, source: "manual" },
      select: { modelId: true },
      orderBy: { createdAt: "asc" },
    });
    const nextModels = uniqueIds([
      ...remoteModelIds,
      ...manualModels.map(({ modelId }) => modelId),
    ]);
    await fillStoredProviderModels(tx, { ...provider, models: nextModels });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: {
        models: nextModels,
        modelsFetchedAt: new Date(),
      },
    });
  });
}

export class ProviderModelError extends Error {}

export async function addProviderModels(
  workspaceId: string,
  providerId: string,
  models: ProviderModelValues[],
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) throw new ProviderModelError("Provider not found.");
    const requestedIds = models.map(({ modelId }) => modelId);
    if (
      new Set(requestedIds).size !== requestedIds.length ||
      requestedIds.some((modelId) => provider.models.includes(modelId))
    ) {
      throw new ProviderModelError("A model with that ID already exists.");
    }
    await tx.providerModel.createMany({
      data: models.map((model) => ({
        ...providerModelData(
          fillProviderModelMetadata(
            model,
            matchingPiModelReferences(
              provider.format,
              [model.modelId, model.name],
              provider.baseUrl,
              provider.name,
            )[0] ?? null,
          ),
        ),
        providerId,
        source: "manual",
      })),
    });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: [...provider.models, ...requestedIds] },
    });
  });
}

export async function updateProviderModel(
  workspaceId: string,
  providerId: string,
  model: ProviderModelValues,
) {
  await db.$transaction(async (tx) => {
    const provider = await lockProvider(tx, workspaceId, providerId);
    if (!provider) throw new ProviderModelError("Provider not found.");
    if (!provider.models.includes(model.modelId)) {
      throw new ProviderModelError("Model not found.");
    }
    const stored = await tx.providerModel.findUnique({
      where: { providerId_modelId: { providerId, modelId: model.modelId } },
      select: { cost: true },
    });
    const metadata = fillProviderModelMetadata(
      {
        ...model,
        cost: model.cost ?? (stored?.cost as ProviderModelValues["cost"]),
      },
      matchingPiModelReferences(
        provider.format,
        [model.modelId, model.name],
        provider.baseUrl,
        provider.name,
      )[0] ?? null,
    );
    const { modelId, ...values } = providerModelData(metadata);
    await tx.providerModel.upsert({
      where: { providerId_modelId: { providerId, modelId } },
      create: { providerId, modelId, ...values, source: "manual" },
      update: { ...values, source: "manual" },
    });
  });
}

export async function deleteProviderModel(
  workspaceId: string,
  providerId: string,
  modelId: string,
) {
  await db.$transaction(async (tx) => {
    if (!(await lockProvider(tx, workspaceId, providerId))) {
      throw new ProviderModelError("Provider not found.");
    }
    const provider = await tx.modelProvider.findUnique({
      where: { id: providerId },
      select: { models: true },
    });
    if (!provider?.models.includes(modelId))
      throw new ProviderModelError("Model not found.");
    const [agent, assistant, knowledgeBase, workspace] = await Promise.all([
      tx.agent.findFirst({
        where: { workspaceId, providerId, model: modelId },
        select: { id: true },
      }),
      tx.chatAssistant.findFirst({
        where: { workspaceId, modelProviderId: providerId, model: modelId },
        select: { id: true },
      }),
      tx.knowledgeBase.findFirst({
        where: { workspaceId, providerId, embeddingModel: modelId },
        select: { id: true },
      }),
      tx.workspace.findFirst({
        where: {
          id: workspaceId,
          OR: [
            { defaultModelProviderId: providerId, defaultModel: modelId },
            { titleModelProviderId: providerId, titleModel: modelId },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (agent || assistant || knowledgeBase || workspace) {
      throw new ProviderModelError(
        "This model is in use and cannot be removed.",
      );
    }
    await tx.providerModel.deleteMany({ where: { providerId, modelId } });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: provider.models.filter((model) => model !== modelId) },
    });
  });
}

export type ConversationRuntimeSession = {
  runtimeSessionId: string;
  runtimeSessionKey: string;
};

function nonEmptyString(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function defaultConversationRuntimeSession(
  agentId: string,
  conversationId: string,
  overrides: Partial<ConversationRuntimeSession> = {},
): ConversationRuntimeSession {
  const runtimeSessionId =
    nonEmptyString(overrides.runtimeSessionId) || conversationId;
  return {
    runtimeSessionId,
    runtimeSessionKey:
      nonEmptyString(overrides.runtimeSessionKey) ||
      `agent:${agentId}:console:${runtimeSessionId}`,
  };
}

export async function createConversation(
  workspaceId: string,
  agentId: string,
  title?: string,
  runtimeSession?: Partial<ConversationRuntimeSession>,
  onCreated?: (
    tx: Prisma.TransactionClient,
    conversationId: string,
  ) => Promise<void>,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) return null;
    const revision = await selectNewSessionRevision(tx, agent.id);
    const conversation = await tx.conversation.create({
      data: {
        agentId,
        title: title ?? null,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const selected = await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(
        agent.id,
        conversation.id,
        runtimeSession,
      ),
    });
    await onCreated?.(tx, selected.id);
    return selected;
  });
}

export async function renameConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: {
      id: true,
      title: true,
      publicApiConversation: { select: { id: true } },
      workSession: { select: { id: true } },
    },
  });
  if (
    !conversation ||
    conversation.title?.startsWith("msg:") ||
    conversation.publicApiConversation ||
    conversation.workSession
  )
    return false;
  const updated = await db.conversation.updateMany({
    where: { id: conversation.id, agentId, agent: { workspaceId } },
    data: { title },
  });
  return updated.count === 1;
}

export async function deleteConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: {
      id: true,
      title: true,
      publicApiConversation: { select: { id: true } },
      workSession: { select: { id: true } },
    },
  });
  if (
    !conversation ||
    conversation.title?.startsWith("msg:") ||
    conversation.publicApiConversation ||
    conversation.workSession
  )
    return false;
  await deleteAgentConversationSandboxes(
    { workspaceId, agentId, conversationId },
    async () => {
      await db.conversation.deleteMany({
        where: { id: conversation.id, agentId, agent: { workspaceId } },
      });
    },
  );
  return true;
}

// Conversations created before runtime session aliases existed are initialized
// lazily on their first runtime request. The nullable-only updates ensure a
// concurrent request never overwrites an alias already chosen by another one.
export async function ensureConversationRuntimeSession(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  fallback: Partial<ConversationRuntimeSession> = {},
): Promise<ConversationRuntimeSession | null> {
  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, agentId, agent: { workspaceId } },
      select: { id: true, runtimeSessionId: true, runtimeSessionKey: true },
    });
    if (!conversation) return null;

    const desired = defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(conversation.runtimeSessionId) ||
        nonEmptyString(fallback.runtimeSessionId) ||
        conversation.id,
      {
        runtimeSessionKey:
          conversation.runtimeSessionKey ?? fallback.runtimeSessionKey,
      },
    );
    if (conversation.runtimeSessionId === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionId: null },
        data: { runtimeSessionId: desired.runtimeSessionId },
      });
    }
    if (conversation.runtimeSessionKey === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionKey: null },
        data: { runtimeSessionKey: desired.runtimeSessionKey },
      });
    }
    const resolved = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { runtimeSessionId: true, runtimeSessionKey: true },
    });
    return defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(resolved?.runtimeSessionId) || desired.runtimeSessionId,
      {
        runtimeSessionKey:
          resolved?.runtimeSessionKey ?? desired.runtimeSessionKey,
      },
    );
  });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  parts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    if (role === "user") {
      const title = conversationTitleFromParts(parts);
      if (title) {
        // Claim the title before inserting the first user message. Concurrent
        // callers serialize on the conversation row, so exactly one can
        // observe a null title with no prior user messages.
        await tx.conversation.updateMany({
          where: {
            id: conversationId,
            title: null,
            messages: {
              none: { role: "user" },
            },
          },
          data: { title },
        });
      }
    }
    return tx.message.create({ data: { conversationId, role, parts } });
  });
}

export async function appendConversationTurn(
  conversationId: string,
  userParts: Prisma.InputJsonValue,
  assistantParts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    const title = conversationTitleFromParts(userParts);
    if (title) {
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          title: null,
          messages: { none: { role: "user" } },
        },
        data: { title },
      });
    }

    // PostgreSQL's now() is stable for an entire transaction. Supply adjacent
    // timestamps so the existing createdAt ordering always keeps the pair in
    // user/assistant order while both writes still commit atomically.
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    const user = await tx.message.create({
      data: {
        conversationId,
        role: "user",
        parts: userParts,
        createdAt: userCreatedAt,
      },
    });
    const assistant = await tx.message.create({
      data: {
        conversationId,
        role: "assistant",
        parts: assistantParts,
        createdAt: assistantCreatedAt,
      },
    });
    return { user, assistant };
  });
}
