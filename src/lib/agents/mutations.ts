import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { deleteAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import { withAgentMaintenanceLease } from "@/lib/agents/agent-execution-gate";
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
  isDedicatedSandboxRuntimeKind,
  normalizeDisabledBuiltinTools,
  type ImplementedAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import { parseAgentMarketResourceMap } from "@/lib/agents/market-setup";
import { sandboxExecutionBusy } from "./sandbox-execution-gate";
import { TERMINAL } from "@/lib/a2a/model";
import { pinCurrentAgentRevision, AgentRevisionError } from "./revisions";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesChecksum,
} from "@/lib/process/mcp-definition";
import {
  parseApprovedToolSignatures,
  parsePendingToolChanges,
} from "@/lib/process/mcp-tool-signature";
import type { PreparedSessionMcpDefinition } from "@/lib/process/mcp-definition";
import type { AgentRevisionConfig } from "./revision-types";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { readMcpInspectorConnection } from "@/lib/workspace/inspector-connection";

function assertNativeAgent(runtimeKind: string, retiredAt: Date | null): void {
  if (runtimeKind !== "pi-sdk" || retiredAt !== null) {
    throw new AgentConfigurationError(
      "Historical Agents are read-only; copy configuration to a native Pi Agent.",
    );
  }
}

const UNAVAILABLE_SANDBOX_STATUSES = [
  "copying",
  "copy_failed",
  "restoring",
  "restore_failed",
  "restore_cleanup_required",
  "upgrading",
  "deleting",
];

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
  piPackages?: Array<{ marketInstallId: string; releaseId: string }>;
};

export type AgentCloneOptions = {
  copyMcp?: boolean;
  copySkills?: boolean;
  copyToolkits?: boolean;
  copySandboxes?: boolean;
  copySubAgents?: boolean;
  copyConversations?: boolean;
};

export const DEFAULT_AGENT_CLONE_OPTIONS: Required<AgentCloneOptions> = {
  copyMcp: false,
  copySkills: false,
  copyToolkits: false,
  copySandboxes: false,
  copySubAgents: false,
  copyConversations: false,
};

function normalizeCloneOptions(
  options: AgentCloneOptions | undefined,
): Required<AgentCloneOptions> {
  if (
    options?.copyMcp ||
    options?.copySkills ||
    options?.copyToolkits ||
    options?.copySandboxes ||
    options?.copySubAgents
  ) {
    throw new AgentConfigurationError(
      "Copies require fresh capability authorization and cannot inherit sandbox or runtime state.",
    );
  }
  return {
    ...DEFAULT_AGENT_CLONE_OPTIONS,
    copyConversations: options?.copyConversations ?? false,
  };
}

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
  if (options.runtime && options.runtime !== "pi-sdk") {
    throw new AgentConfigurationError("Only native Pi Agents can be created.");
  }
  const agent = await tx.agent.create({
    data: { workspaceId, name, slug, runtimeKind: "pi-sdk" },
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
      "pi-sdk",
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
  const cloneOptions = normalizeCloneOptions(options);
  return db.$transaction(
    async (tx) => {
      const source = await tx.agent.findFirst({
        where: { id: sourceAgentId, workspaceId },
        select: {
          name: true,
          description: true,
          systemPrompt: true,
          disabledBuiltinTools: true,
          maxSteps: true,
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
          systemPrompt: source.systemPrompt,
          disabledBuiltinTools: source.disabledBuiltinTools,
          maxSteps: source.maxSteps,
        },
      });
      const conversationIds = cloneOptions.copyConversations
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
  piPackages?: Array<{ marketInstallId: string; releaseId: string }>;
};

export type AgentToolSelection = {
  deploymentIds: string[];
  installedSkillIds: string[];
  toolkitIds: string[];
  sandboxIds?: string[];
  defaultSandboxId?: string | null;
  subAgentIds?: string[];
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
  piPackages: Array<{ marketInstallId: string; releaseId: string }> | undefined,
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
        typeof pkg.releaseId !== "string" ||
        !pkg.releaseId,
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
  // Validate each install/release belongs to workspace and is approved
  for (const pkg of piPackages) {
    const install = await tx.marketInstall.findFirst({
      where: { id: pkg.marketInstallId, targetWorkspaceId: workspaceId },
      select: {
        id: true,
        listingId: true,
        status: true,
        listing: { select: { kind: true, status: true } },
        currentReleaseId: true,
      },
    });
    if (!install)
      throw new AgentConfigurationError(
        `Unknown or inaccessible market install: ${pkg.marketInstallId}`,
      );
    if (install.listing.kind !== "pi-package")
      throw new AgentConfigurationError(
        `Market install is not a pi-package: ${pkg.marketInstallId}`,
      );
    if (install.listing.status !== "published")
      throw new AgentConfigurationError(
        `Listing is not published: ${pkg.marketInstallId}`,
      );
    if (install.status !== "ready")
      throw new AgentConfigurationError(
        `Market install is not ready: ${pkg.marketInstallId}`,
      );
    const release = await tx.marketRelease.findFirst({
      where: { id: pkg.releaseId, listingId: install.listingId },
      select: { id: true, listingId: true, reviewStatus: true },
    });
    if (release?.reviewStatus !== "approved")
      throw new AgentConfigurationError(
        `Release not approved: ${pkg.releaseId}`,
      );
  }
  const existing = await tx.agentPiPackage.findMany({ where: { agentId } });
  if (
    existing.length === piPackages.length &&
    existing.every((bound) =>
      piPackages.some(
        (pkg) =>
          pkg.marketInstallId === bound.marketInstallId &&
          pkg.releaseId === bound.releaseId,
      ),
    )
  )
    return;
  const sandboxes = await tx.agentSandbox.findMany({
    where: { agentId },
    select: { sandboxId: true },
  });
  if (sandboxes.some(({ sandboxId }) => sandboxExecutionBusy(sandboxId))) {
    throw new AgentConfigurationError("pi_package_agent_busy");
  }
  // Check agent is not busy (no active A2A task, Work, or execution lease)
  const busyTask = await tx.a2ATask.findFirst({
    where: {
      context: { agentId, workspaceId },
      state: { notIn: TERMINAL },
    },
    select: { id: true },
  });
  if (busyTask) throw new AgentConfigurationError("pi_package_agent_busy");
  const busyWork = await tx.workSession.findFirst({
    where: {
      agentId,
      status: { in: ["queued", "running", "waiting_approval", "cancelling"] },
    },
    select: { id: true },
  });
  if (busyWork) throw new AgentConfigurationError("pi_package_agent_busy");
  // Write: replace all bindings atomically
  await tx.agentPiPackage.deleteMany({ where: { agentId } });
  if (piPackages.length > 0) {
    await tx.agentPiPackage.createMany({
      data: piPackages.map((pkg) => ({
        agentId,
        marketInstallId: pkg.marketInstallId,
        releaseId: pkg.releaseId,
      })),
    });
  }
}

export async function setAgentPiPackages(
  workspaceId: string,
  agentId: string,
  piPackages: NonNullable<AgentConfig["piPackages"]>,
) {
  return withAgentMaintenanceLease(agentId, () =>
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

export async function bindAgentWorkspaceResource(
  workspaceId: string,
  agentId: string,
  resource: { kind: "skill" | "mcp"; id: string },
) {
  return withAgentMaintenanceLease(agentId, () =>
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
        select: { sandboxes: { select: { sandboxId: true } } },
      });
      if (!agent)
        throw new AgentConfigurationError("resource_binding_unavailable");
      if (
        agent.sandboxes.some(({ sandboxId }) => sandboxExecutionBusy(sandboxId))
      )
        throw new AgentConfigurationError("resource_binding_busy");
      const task = await tx.a2ATask.findFirst({
        where: {
          context: { agentId, workspaceId },
          state: { notIn: TERMINAL },
        },
        select: { id: true },
      });
      const work = await tx.workSession.findFirst({
        where: {
          agentId,
          workspaceId,
          status: {
            in: ["queued", "running", "waiting_approval", "cancelling"],
          },
        },
        select: { id: true },
      });
      if (task || work)
        throw new AgentConfigurationError("resource_binding_busy");
      const market = {
        include: { listing: true, currentRelease: true },
      } as const;
      const selected =
        resource.kind === "skill"
          ? await tx.installedSkill.findFirst({
              where: { id: resource.id, workspaceId },
              include: { marketInstall: market },
            })
          : await tx.deployment.findFirst({
              where: {
                id: resource.id,
                workspaceId,
                OR: [{ source: null }, { source: { not: "sandbox" } }],
              },
              include: { marketInstall: market },
            });
      if (!selected)
        throw new AgentConfigurationError("resource_binding_unavailable");
      const install = selected.marketInstall;
      if (
        install &&
        (!["ready", "modified", "setup_required"].includes(install.status) ||
          install.currentRelease.reviewStatus !== "approved" ||
          install.currentRelease.listingId !== install.listingId ||
          install.listing.status !== "published" ||
          (install.listing.visibility !== "public" &&
            install.listing.publisherWorkspaceId !== workspaceId))
      )
        throw new AgentConfigurationError("resource_binding_unavailable");
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
        await tx.agentServer.upsert({
          where: {
            agentId_deploymentId: { agentId, deploymentId: resource.id },
          },
          create: { agentId, deploymentId: resource.id },
          update: {},
        });
      }
    }),
  );
}

function assertRuntimeProviderFormat(runtime: string, format: string) {
  if (!agentRuntimeSupportsProviderFormat(runtime, format)) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} does not support provider format "${format}".`,
    );
  }
}

function assertRuntimeSandboxes(
  runtime: string,
  requestedIds: readonly string[],
  sandboxes: readonly {
    id: string;
    kind: string;
    network: string;
    config?: Prisma.JsonValue | null;
  }[],
  allowAutomatic = false,
) {
  if (
    sandboxes.some(
      ({ config }) =>
        config &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        config.readOnly === true,
    )
  ) {
    throw new AgentConfigurationError(
      "Read-only sandboxes cannot be assigned as Agent templates.",
    );
  }
  if (
    sandboxes.some(
      ({ config }) =>
        config &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        config.managedBy === "agent-conversation",
    )
  ) {
    throw new AgentConfigurationError(
      "Conversation-owned sandboxes cannot be assigned as Agent templates.",
    );
  }
  if (!isDedicatedSandboxRuntimeKind(runtime)) return;
  if (allowAutomatic && requestedIds.length === 0) return;
  if (
    requestedIds.length !== 1 ||
    sandboxes.length !== 1 ||
    sandboxes[0]?.kind !== "docker"
  ) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} requires exactly one Docker sandbox.`,
    );
  }
  if (sandboxes[0]?.network === "none") {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} requires a networked Docker sandbox.`,
    );
  }
}

type SandboxAssignmentConflict = {
  agent: { name: string };
  sandbox: { name: string };
};

function assertSandboxesUnassigned(conflict: SandboxAssignmentConflict | null) {
  if (!conflict) return;
  throw new AgentConfigurationError(
    `Sandbox "${conflict.sandbox.name}" is already assigned to agent "${conflict.agent.name}". Choose an unassigned sandbox.`,
  );
}

function isSandboxAssignmentConstraintError(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const meta = "meta" in error ? error.meta : undefined;
  return JSON.stringify(meta ?? "").includes("sandboxId");
}

function rethrowSandboxAssignmentConstraint(error: unknown): never {
  if (isSandboxAssignmentConstraintError(error)) {
    throw new AgentConfigurationError(
      "The selected sandbox was assigned to another agent. Choose an unassigned sandbox.",
    );
  }
  throw error;
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
async function validateNativeModelSelection(
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
  options: CreateAgentOptions,
) {
  if (options.runtime && options.runtime !== "pi-sdk") {
    throw new AgentConfigurationError("Only native Pi Agents can be created.");
  }
  const runtime = "pi-sdk";
  if (tools.sandboxIds?.length) {
    throw new AgentConfigurationError(
      "New Agents receive an automatic dedicated sandbox template.",
    );
  }
  const cleanName = cfg.name.trim() || "New agent";
  const deploymentIds = uniqueIds(tools.deploymentIds);
  const installedSkillIds = uniqueIds(tools.installedSkillIds);
  const toolkitIds = uniqueIds(tools.toolkitIds);
  const sandboxIds = uniqueIds(tools.sandboxIds ?? []);
  const subAgentIds = uniqueIds(tools.subAgentIds ?? []);

  try {
    return await db.$transaction(
      async (tx) => {
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
          throw new AgentConfigurationError(
            "A model requires a model provider.",
          );
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
          select: { id: true },
        });
        const skills = await tx.installedSkill.findMany({
          where: { id: { in: installedSkillIds }, workspaceId },
          select: { id: true },
        });
        const toolkits = await tx.toolkit.findMany({
          where: { id: { in: toolkitIds }, workspaceId },
          select: { id: true },
        });
        const sandboxes = await tx.sandbox.findMany({
          where: {
            id: { in: sandboxIds },
            workspaceId,
            deployment: { status: { notIn: UNAVAILABLE_SANDBOX_STATUSES } },
          },
          select: { id: true, kind: true, network: true, config: true },
        });
        const subAgents = await tx.agent.findMany({
          where: { id: { in: subAgentIds }, workspaceId },
          select: { id: true },
        });
        const sandboxConflict = await tx.agentSandbox.findFirst({
          where: { sandboxId: { in: sandboxIds } },
          select: {
            agent: { select: { name: true } },
            sandbox: { select: { name: true } },
          },
        });
        assertExactResources("MCP deployment", deploymentIds, deployments);
        assertExactResources("installed skill", installedSkillIds, skills);
        assertExactResources("toolkit", toolkitIds, toolkits);
        assertExactResources("sandbox", sandboxIds, sandboxes);
        assertExactResources("sub-agent", subAgentIds, subAgents);
        assertRuntimeSandboxes(runtime, sandboxIds, sandboxes, true);
        assertSandboxesUnassigned(sandboxConflict);

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
          },
        });
        await tx.agentServer.createMany({
          data: deployments.map(({ id }) => ({
            agentId: agent.id,
            deploymentId: id,
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
        await tx.agentSandbox.createMany({
          data: sandboxes.map(({ id }) => ({
            agentId: agent.id,
            sandboxId: id,
            isDefault:
              isDedicatedSandboxRuntimeKind(runtime) ||
              id === tools.defaultSandboxId ||
              (!tools.defaultSandboxId && id === sandboxes[0]?.id),
          })),
        });
        await tx.agentSubAgent.createMany({
          data: subAgents.map(({ id }) => ({
            parentId: agent.id,
            childId: id,
          })),
        });
        await validateAndWritePiPackages(
          tx,
          workspaceId,
          agent.id,
          runtime,
          options.piPackages ?? cfg.piPackages,
        );
        return agent;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (error) {
    rethrowSandboxAssignmentConstraint(error);
  }
}

export async function updateAgent(
  workspaceId: string,
  agentId: string,
  cfg: AgentConfig,
) {
  return withAgentMaintenanceLease(agentId, async () => {
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

async function requireMcpConnectionAdmin(
  tx: Pick<Prisma.TransactionClient, "user" | "workspace">,
  workspaceId: string,
  userId: string,
) {
  const user = await tx.user.findFirst({
    where: { id: userId, status: "active" },
    select: { role: true },
  });
  const workspace =
    user &&
    (await tx.workspace.findFirst({
      where: {
        id: workspaceId,
        status: "active",
        OR: [
          { ownerId: userId },
          { members: { some: { userId, role: { in: ["owner", "admin"] } } } },
          ...(user.role === "admin" ? [{}] : []),
        ],
      },
      select: { id: true },
    }));
  if (!workspace)
    throw new AgentConfigurationError("MCP_CONNECTION_NOT_AUTHORIZED");
}

export type ReviewedAgentMcpConnection = {
  deploymentId: string;
  allowedToolNames: string[];
  prepared: PreparedSessionMcpDefinition;
};

/** Authorize reviewed connection scopes in the caller's atomic publication transaction. */
export async function applyReviewedAgentMcpGrantsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    expectedRevisionId: string;
    connections: readonly ReviewedAgentMcpConnection[];
  },
) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
  await requireMcpConnectionAdmin(tx, input.workspaceId, input.userId);
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${input.agentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
  const agent = await tx.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      runtimeKind: "pi-sdk",
      retiredAt: null,
      publicRuntimeAllocation: { is: null },
    },
    select: { id: true },
  });
  if (!agent) throw new AgentConfigurationError("AGENT_EXECUTION_RETIRED");
  const current = await pinCurrentAgentRevision(tx, input.agentId);
  if (current.id !== input.expectedRevisionId)
    throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
  if (
    new Set(input.connections.map((entry) => entry.deploymentId)).size !==
    input.connections.length
  )
    throw new AgentConfigurationError("MCP_TOOL_SELECTION_CHANGED");
  const grants: AgentRevisionConfig["mcpGrants"] = [];
  for (const connection of [...input.connections].sort((left, right) =>
    left.deploymentId.localeCompare(right.deploymentId),
  )) {
    const allowedToolNames = z
      .array(z.string().min(1).max(240))
      .max(1_000)
      .refine((names) => new Set(names).size === names.length)
      .parse(connection.allowedToolNames);
    await tx.$queryRaw`SELECT id FROM "Deployment" WHERE id=${connection.deploymentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
    const live = await tx.deployment.findFirst({
      where: {
        id: connection.deploymentId,
        workspaceId: input.workspaceId,
        OR: [{ source: null }, { source: { not: "sandbox" } }],
      },
    });
    if (
      !live ||
      mcpDefinitionChecksum(live) !== connection.prepared.definitionChecksum
    )
      throw new AgentConfigurationError("MCP_DEFINITION_CHANGED");
    const sandboxId = current.config.sandboxTemplateId;
    const sandbox =
      sandboxId &&
      (await tx.agentSandbox.findFirst({
        where: {
          agentId: input.agentId,
          sandboxId,
          isDefault: true,
          sandbox: { workspaceId: input.workspaceId, kind: "docker" },
        },
        select: { sandboxId: true },
      }));
    const runtimeFilesChecksum = await mcpRuntimeFilesChecksum(
      tx,
      connection.deploymentId,
    );
    const discovery = readMcpInspectorConnection(live.installCfg);
    if (
      !sandbox ||
      !discovery ||
      discovery.sandboxId !== sandboxId ||
      discovery.definitionChecksum !== connection.prepared.definitionChecksum ||
      discovery.runtimeFilesChecksum !== runtimeFilesChecksum
    )
      throw new AgentConfigurationError("MCP_DISCOVERY_REQUIRED");
    const discoveredNames = new Set(
      readMcpToolCatalog(live.installCfg).map((tool) => tool.name),
    );
    if (allowedToolNames.some((name) => !discoveredNames.has(name)))
      throw new AgentConfigurationError("MCP_TOOL_SELECTION_CHANGED");
    if (
      live.mcpToolExposure === "allowlist" &&
      allowedToolNames.some((name) => !live.mcpAllowedTools.includes(name))
    )
      throw new AgentConfigurationError("MCP_TOOLS_NOT_EXPOSED");
    await tx.agentServer.upsert({
      where: {
        agentId_deploymentId: {
          agentId: input.agentId,
          deploymentId: connection.deploymentId,
        },
      },
      create: {
        agentId: input.agentId,
        deploymentId: connection.deploymentId,
        allowedToolNames,
      },
      update: { allowedToolNames },
    });
    grants.push({
      deploymentId: connection.deploymentId,
      ...connection.prepared,
      runtimeFilesChecksum,
      allowedToolNames,
    });
  }
  return { current, grants };
}

export async function setAgentTools(
  workspaceId: string,
  agentId: string,
  tools: AgentToolSelection,
) {
  return withAgentMaintenanceLease(agentId, async () => {
    const agent = await db.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: {
        id: true,
        runtimeKind: true,
        retiredAt: true,
        sandboxes: { select: { sandboxId: true } },
      },
    });
    if (!agent) return;
    assertNativeAgent(agent.runtimeKind, agent.retiredAt);
    const previousIds = agent.sandboxes.map(({ sandboxId }) => sandboxId);
    const requestedSandboxIds = uniqueIds(
      tools.sandboxIds?.length ? tools.sandboxIds : previousIds,
    );
    if (
      previousIds.length !== requestedSandboxIds.length ||
      previousIds.some((id) => !requestedSandboxIds.includes(id))
    ) {
      const allocated = await db.sandbox.findFirst({
        where: {
          workspaceId,
          AND: [
            { config: { path: ["managedBy"], equals: "agent-conversation" } },
            { config: { path: ["agentId"], equals: agentId } },
          ],
        },
        select: { id: true },
      });
      if (allocated)
        throw new AgentConfigurationError(
          "Delete this Agent's isolated conversations/native contexts and finish their sandbox cleanup before changing its assigned template.",
        );
    }
    const [
      deployments,
      skills,
      toolkits,
      sandboxes,
      subAgents,
      sandboxConflict,
    ] = await Promise.all([
      db.deployment.findMany({
        where: { id: { in: tools.deploymentIds }, workspaceId },
        select: { id: true },
      }),
      db.installedSkill.findMany({
        where: { id: { in: tools.installedSkillIds }, workspaceId },
        select: { id: true },
      }),
      db.toolkit.findMany({
        where: { id: { in: tools.toolkitIds }, workspaceId },
        select: { id: true },
      }),
      db.sandbox.findMany({
        where: {
          id: { in: requestedSandboxIds },
          workspaceId,
          deployment: {
            status: { notIn: UNAVAILABLE_SANDBOX_STATUSES },
          },
        },
        select: { id: true, kind: true, network: true, config: true },
      }),
      // Same-workspace agents only, never the agent itself (no self-delegation).
      db.agent.findMany({
        where: {
          id: { in: tools.subAgentIds ?? [], not: agentId },
          workspaceId,
        },
        select: { id: true },
      }),
      db.agentSandbox.findFirst({
        where: {
          sandboxId: { in: requestedSandboxIds },
          agentId: { not: agentId },
        },
        select: {
          agent: { select: { name: true } },
          sandbox: { select: { name: true } },
        },
      }),
    ]);
    assertRuntimeSandboxes(agent.runtimeKind, requestedSandboxIds, sandboxes);
    assertSandboxesUnassigned(sandboxConflict);
    try {
      await db.$transaction([
        db.agentServer.deleteMany({
          where: {
            agentId,
            deploymentId: {
              notIn: deployments.map((deployment) => deployment.id),
            },
          },
        }),
        db.agentSkill.deleteMany({ where: { agentId } }),
        db.agentToolkit.deleteMany({ where: { agentId } }),
        db.agentSandbox.deleteMany({ where: { agentId } }),
        db.agentSubAgent.deleteMany({ where: { parentId: agentId } }),
        db.agentServer.createMany({
          data: deployments.map((d) => ({ agentId, deploymentId: d.id })),
          skipDuplicates: true,
        }),
        db.agentSkill.createMany({
          data: skills.map((s) => ({ agentId, installedSkillId: s.id })),
        }),
        db.agentToolkit.createMany({
          data: toolkits.map((t) => ({ agentId, toolkitId: t.id })),
        }),
        db.agentSandbox.createMany({
          data: sandboxes.map((s) => ({
            agentId,
            sandboxId: s.id,
            isDefault:
              isDedicatedSandboxRuntimeKind(agent.runtimeKind) ||
              s.id === tools.defaultSandboxId ||
              (!tools.defaultSandboxId && s.id === sandboxes[0]?.id),
          })),
        }),
        db.agentSubAgent.createMany({
          data: subAgents.map((s) => ({ parentId: agentId, childId: s.id })),
        }),
      ]);
    } catch (error) {
      rethrowSandboxAssignmentConstraint(error);
    }
  });
}

export async function getAgentDeleteTargets(
  workspaceId: string,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      marketInstall: { select: { resourceMap: true } },
    },
  });
  if (!agent) return { agentIds: [], sandboxes: [] };
  const map = agent.marketInstall
    ? parseAgentMarketResourceMap(agent.marketInstall.resourceMap)
    : null;
  if (
    agent.marketInstall &&
    (!map || !Object.values(map.agents).includes(agentId))
  ) {
    throw new Error("The marketplace install resource map is invalid.");
  }
  const requestedAgentIds = map
    ? [...new Set([agentId, ...Object.values(map.agents)])]
    : [agentId];
  const agents = await db.agent.findMany({
    where: { workspaceId, id: { in: requestedAgentIds } },
    select: {
      id: true,
      parentLinks: {
        where: { parentId: { notIn: requestedAgentIds } },
        take: 1,
        select: { parentId: true },
      },
      marketInstall: { select: { id: true } },
      unifiedMarketInstall: { select: { id: true } },
      sourceMarketListing: { select: { id: true } },
      publicEndpoints: { take: 1, select: { id: true } },
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
  const deletableAgents = agents.filter(
    (candidate) =>
      candidate.id === agentId ||
      (candidate.parentLinks.length === 0 &&
        !candidate.marketInstall &&
        !candidate.unifiedMarketInstall &&
        !candidate.sourceMarketListing &&
        candidate.publicEndpoints.length === 0),
  );
  const allowedSandboxIds = new Set(Object.values(map?.sandboxes ?? {}));
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
    if (
      map &&
      allowedSandboxIds.size > 0 &&
      !allowedSandboxIds.has(candidate.id)
    )
      continue;
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
  const install = await db.agentInstall.findFirst({
    where: { agentId, targetWorkspaceId: workspaceId },
    select: {
      id: true,
      resourceMap: true,
      release: { select: { listingId: true } },
    },
  });
  if (install) {
    const resourceMap = parseAgentMarketResourceMap(install.resourceMap);
    if (!resourceMap || !Object.values(resourceMap.agents).includes(agentId)) {
      throw new Error("The marketplace install resource map is invalid.");
    }
    const candidateAgentIds = [...new Set(Object.values(resourceMap.agents))];
    return db.$transaction(
      async (tx) => {
        const candidates = await tx.agent.findMany({
          where: { workspaceId, id: { in: candidateAgentIds } },
          select: {
            id: true,
            parentLinks: {
              where: { parentId: { notIn: candidateAgentIds } },
              take: 1,
              select: { parentId: true },
            },
            marketInstall: { select: { id: true } },
            unifiedMarketInstall: { select: { id: true } },
            sourceMarketListing: { select: { id: true } },
            publicEndpoints: { take: 1, select: { id: true } },
          },
        });
        const deletableAgentIds = candidates
          .filter(
            (candidate) =>
              candidate.id === agentId ||
              (candidate.parentLinks.length === 0 &&
                !candidate.marketInstall &&
                !candidate.unifiedMarketInstall &&
                !candidate.sourceMarketListing &&
                candidate.publicEndpoints.length === 0),
          )
          .map(({ id }) => id);

        const candidateToolkitIds = [
          ...new Set(Object.values(resourceMap.toolkits)),
        ];
        const toolkits = await tx.toolkit.findMany({
          where: { workspaceId, id: { in: candidateToolkitIds } },
          select: {
            id: true,
            visibility: true,
            agentLinks: {
              where: { agentId: { notIn: deletableAgentIds } },
              take: 1,
              select: { agentId: true },
            },
            sourceMarketListing: { select: { id: true } },
            marketInstall: { select: { id: true } },
            installLinks: { take: 1, select: { id: true } },
            apiTokens: { take: 1, select: { id: true } },
          },
        });
        const deletableToolkitIds = toolkits
          .filter(
            (toolkit) =>
              toolkit.visibility === "private" &&
              toolkit.agentLinks.length === 0 &&
              !toolkit.sourceMarketListing &&
              !toolkit.marketInstall &&
              toolkit.installLinks.length === 0 &&
              toolkit.apiTokens.length === 0,
          )
          .map(({ id }) => id);

        const candidateDeploymentIds = [
          ...new Set(Object.values(resourceMap.deployments)),
        ];
        const deployments = await tx.deployment.findMany({
          where: { workspaceId, id: { in: candidateDeploymentIds } },
          select: {
            id: true,
            serverId: true,
            publicInvocable: true,
            agentLinks: {
              where: { agentId: { notIn: deletableAgentIds } },
              take: 1,
              select: { agentId: true },
            },
            toolkitLinks: {
              where: { toolkitId: { notIn: deletableToolkitIds } },
              take: 1,
              select: { toolkitId: true },
            },
            chatAssistantGrants: { take: 1, select: { assistantId: true } },
            sourceMarketListing: { select: { id: true } },
            marketInstall: { select: { id: true } },
          },
        });
        const deletableDeploymentIds = deployments
          .filter(
            (deployment) =>
              !deployment.serverId &&
              !deployment.publicInvocable &&
              deployment.agentLinks.length === 0 &&
              deployment.toolkitLinks.length === 0 &&
              deployment.chatAssistantGrants.length === 0 &&
              !deployment.sourceMarketListing &&
              !deployment.marketInstall,
          )
          .map(({ id }) => id);

        const candidateSkillIds = [
          ...new Set(Object.values(resourceMap.skills)),
        ];
        const skills = await tx.installedSkill.findMany({
          where: { workspaceId, id: { in: candidateSkillIds } },
          select: {
            id: true,
            skillId: true,
            agentLinks: {
              where: { agentId: { notIn: deletableAgentIds } },
              take: 1,
              select: { agentId: true },
            },
            toolkitLinks: {
              where: { toolkitId: { notIn: deletableToolkitIds } },
              take: 1,
              select: { toolkitId: true },
            },
            sourceMarketListing: { select: { id: true } },
            marketInstall: { select: { id: true } },
          },
        });
        const deletableSkillIds = skills
          .filter(
            (skill) =>
              !skill.skillId &&
              skill.agentLinks.length === 0 &&
              skill.toolkitLinks.length === 0 &&
              !skill.sourceMarketListing &&
              !skill.marketInstall,
          )
          .map(({ id }) => id);

        const mappedSandboxIds = [
          ...new Set(Object.values(resourceMap.sandboxes)),
        ];
        const legacySandboxes = await tx.sandbox.findMany({
          where: {
            workspaceId,
            agentLinks: {
              some: { agentId: { in: deletableAgentIds } },
            },
            ...(mappedSandboxIds.length > 0
              ? { id: { in: mappedSandboxIds } }
              : {}),
          },
          select: { id: true, deploymentId: true },
        });
        const sandboxDeploymentIds = legacySandboxes.map(
          ({ deploymentId }) => deploymentId,
        );

        await tx.agentInstall.delete({ where: { id: install.id } });
        await tx.agent.deleteMany({
          where: { workspaceId, id: { in: deletableAgentIds } },
        });
        await tx.toolkit.deleteMany({
          where: { workspaceId, id: { in: deletableToolkitIds } },
        });
        await tx.installedSkill.deleteMany({
          where: { workspaceId, id: { in: deletableSkillIds } },
        });
        await tx.deployment.deleteMany({
          where: {
            workspaceId,
            id: {
              in: [
                ...new Set([
                  ...deletableDeploymentIds,
                  ...sandboxDeploymentIds,
                ]),
              ],
            },
          },
        });
        await tx.agentListing.updateMany({
          where: { id: install.release.listingId, installCount: { gt: 0 } },
          data: { installCount: { decrement: 1 } },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

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
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) return null;
    const revision = await pinCurrentAgentRevision(tx, agent.id);
    const conversation = await tx.conversation.create({
      data: {
        agentId,
        title: title ?? null,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    return tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(
        agent.id,
        conversation.id,
        runtimeSession,
      ),
    });
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

// Re-approving a drifted tool is an operational acknowledgment, not a
// revision/config change: it clears the pause recorded by
// syncMcpToolApprovalState once an admin has reviewed the before/after diff.
export async function approveAgentMcpToolChanges(
  workspaceId: string,
  agentId: string,
  deploymentId: string,
  toolNames?: readonly string[],
) {
  return db.$transaction(async (tx) => {
    const row = await tx.agentServer.findFirst({
      where: { agentId, deploymentId, agent: { workspaceId } },
      select: {
        agentId: true,
        deploymentId: true,
        approvedToolSignatures: true,
        pendingToolChanges: true,
      },
    });
    if (!row) throw new AgentConfigurationError("MCP_GRANT_NOT_FOUND");
    const approved = parseApprovedToolSignatures(row.approvedToolSignatures);
    const pending = parsePendingToolChanges(row.pendingToolChanges);
    const targets = toolNames ?? Object.keys(pending);
    for (const name of targets) {
      const change = pending[name];
      if (!change) continue;
      approved[name] = change.currentSignature;
      delete pending[name];
    }
    await tx.agentServer.update({
      where: { agentId_deploymentId: { agentId, deploymentId } },
      data: {
        approvedToolSignatures: approved as Prisma.InputJsonValue,
        pendingToolChanges: pending as Prisma.InputJsonValue,
      },
    });
    return { approvedToolSignatures: approved, pendingToolChanges: pending };
  });
}
