import type { ToolApprovalPolicy } from "./tool-approval-policy";
import "server-only";
import type { ReasoningLevel } from "./constants";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { visiblePluginWhere } from "@/lib/plugins/catalog";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { withAgentDraftLease } from "@/lib/agents/agent-execution-gate";
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  normalizeDisabledBuiltinTools,
  normalizeOptionalBuiltinTools,
} from "@/lib/agents/runtime-kind";
import {
  type ExternalSandboxAccess,
  isExternalSandboxAccess,
  isExternalSandboxCandidate,
  MAX_EXTERNAL_SANDBOXES,
} from "@/lib/sandboxes/external";
import { ensureWorkspaceMcpDeploymentPinned } from "@/lib/process/mcp-pinning";
import { catalogToolNames } from "@/lib/process/mcp-grant-sync";
import { AgentAdvisorSchema, type AgentAdvisor } from "./revision-types";
import {
  AgentConfigurationError,
  assertNativeAgent,
} from "./agent-mutation-guards";
import type { ExecutableAgentRuntimeKind } from "./runtime-kind";
import { lockProvider } from "./provider-mutations";

/** Validated outside the write so a rejected selection never touches existing rows. */
export async function validateExternalSandboxes(
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

export async function validateAdvisor(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  advisor: AgentAdvisor | null | undefined,
) {
  if (!advisor) return;
  const parsed = AgentAdvisorSchema.safeParse(advisor);
  if (!parsed.success)
    throw new AgentConfigurationError("AGENT_ADVISOR_INVALID");
  const provider = await lockProvider(tx, workspaceId, advisor.providerId);
  if (!provider?.models.includes(advisor.model))
    throw new AgentConfigurationError("AGENT_ADVISOR_INVALID");
  assertRuntimeProviderFormat("pi-sdk", provider.format);
}

export type AgentConfig = {
  name: string;
  description?: string | null;
  systemPrompt: string | null;
  contextFiles?: boolean;
  providerId: string | null;
  model: string | null;
  disabledBuiltinTools?: string[];
  optionalBuiltinTools?: string[];
  maxSteps: number;
  reasoningEffort?: ReasoningLevel | null;
  toolApproval?: ToolApprovalPolicy;
  secretObfuscation?: boolean;
  /** Seconds; null resets to the system default, undefined leaves it unchanged. */
  taskTimeoutSeconds?: number | null;
  /** Seconds; null inherits the system default, undefined leaves it unchanged. */
  mcpToolTimeoutSeconds?: number | null;
  advisor?: AgentAdvisor | null;
  piPackages?: Array<{ marketInstallId: string; releaseId?: string }>;
};

export type ExternalSandboxSelection = {
  sandboxId: string;
  access: ExternalSandboxAccess;
};

export type AgentToolSelection = {
  deploymentIds: string[];
  /** Missing entries preserve retained overrides; null resets to the Agent default. */
  mcpToolTimeouts?: ReadonlyMap<string, number | null>;
  installedSkillIds: string[];
  toolkitIds: string[];
  /** Full desired set; omit to keep current attachments. */
  externalSandboxes?: ExternalSandboxSelection[];
};

export function validatedOptionalBuiltinTools(
  tools: readonly string[] | undefined,
) {
  try {
    return normalizeOptionalBuiltinTools(tools);
  } catch {
    throw new AgentConfigurationError("OPTIONAL_BUILTIN_TOOLS_INVALID");
  }
}

/** Save draft authority only; publishing still requires the normal revision review. */
export async function updateAgentOptionalBuiltinTools(
  workspaceId: string,
  agentId: string,
  tools: readonly string[],
) {
  const optionalBuiltinTools = validatedOptionalBuiltinTools(tools);
  return withAgentDraftLease(agentId, () =>
    db.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({
        where: { id: agentId, workspaceId },
        select: { runtimeKind: true, retiredAt: true },
      });
      if (!agent) return null;
      assertNativeAgent(agent.runtimeKind, agent.retiredAt);
      return tx.agent.update({
        where: { id: agentId },
        data: { optionalBuiltinTools },
      });
    }),
  );
}

export async function validateAndWritePiPackages(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  runtimeKind: ExecutableAgentRuntimeKind,
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
        select: { id: true },
      });
      if (!agent) throw new AgentConfigurationError("pi_package_unavailable");
      await validateAndWritePiPackages(
        tx,
        workspaceId,
        agentId,
        "pi-sdk",
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
  resource:
    | { kind: "skill"; id: string }
    | { kind: "mcp"; id: string; toolTimeoutSeconds?: number | null },
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
        const data = {
          allowedToolNames: catalogToolNames(deployment.installCfg),
          ...(resource.toolTimeoutSeconds === undefined
            ? {}
            : { toolTimeoutSeconds: resource.toolTimeoutSeconds }),
        };
        await tx.agentServer.upsert({
          where: {
            agentId_deploymentId: { agentId, deploymentId: resource.id },
          },
          create: { agentId, deploymentId: resource.id, ...data },
          update: data,
        });
      }
    });
  });
}

export function assertRuntimeProviderFormat(
  runtime: ExecutableAgentRuntimeKind,
  format: string,
) {
  if (!agentRuntimeSupportsProviderFormat(runtime, format)) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} does not support provider format "${format}".`,
    );
  }
}

export async function validateNativeModelSelection(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runtimeKind: ExecutableAgentRuntimeKind,
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

export function assertExactResources(
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
      await validateAdvisor(tx, workspaceId, cfg.advisor);
      await tx.agent.updateMany({
        where: { id: agentId, workspaceId },
        data: {
          name: cfg.name,
          ...(cfg.description === undefined
            ? {}
            : { description: cfg.description?.trim() || null }),
          systemPrompt: cfg.systemPrompt,
          ...(cfg.contextFiles !== undefined
            ? { contextFiles: cfg.contextFiles }
            : {}),
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
          ...(cfg.optionalBuiltinTools === undefined
            ? {}
            : {
                optionalBuiltinTools: validatedOptionalBuiltinTools(
                  cfg.optionalBuiltinTools,
                ),
              }),
          maxSteps: cfg.maxSteps,
          ...(cfg.reasoningEffort !== undefined
            ? { reasoningEffort: cfg.reasoningEffort }
            : {}),
          ...(cfg.toolApproval !== undefined
            ? { toolApproval: cfg.toolApproval }
            : {}),
          ...(cfg.secretObfuscation === undefined
            ? {}
            : { secretObfuscation: cfg.secretObfuscation }),
          ...(cfg.taskTimeoutSeconds === undefined
            ? {}
            : { taskTimeoutSeconds: cfg.taskTimeoutSeconds }),
          ...(cfg.mcpToolTimeoutSeconds === undefined
            ? {}
            : { mcpToolTimeoutSeconds: cfg.mcpToolTimeoutSeconds }),
          ...(cfg.advisor !== undefined
            ? { advisor: cfg.advisor ?? Prisma.DbNull }
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
        const toolTimeoutSeconds = tools.mcpToolTimeouts?.get(deployment.id);
        const data = {
          allowedToolNames: catalogToolNames(deployment.installCfg),
          ...(toolTimeoutSeconds === undefined ? {} : { toolTimeoutSeconds }),
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
