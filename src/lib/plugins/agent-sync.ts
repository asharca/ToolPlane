import "server-only";
import { db } from "@/lib/db";
import { TERMINAL } from "@/lib/a2a/model";
import {
  AgentExecutionBusyError,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";
import { sandboxExecutionBusy } from "@/lib/agents/sandbox-execution-gate";
import { pinCurrentAgentRevision } from "@/lib/agents/revisions";
import { applyPiPackageToAgent } from "@/lib/pi-packages/agent-apply";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { prepareSessionMcpDefinition } from "@/lib/process/mcp-definition";
import { ensureWorkspaceMcpDeploymentPinned } from "@/lib/process/mcp-pinning";
import { resolvePiPackageMcpPolicy } from "@/lib/agents/pi-package-mcp";
import type { AgentPackageMcpConnection } from "@/lib/pi-packages/agent-apply";
import {
  PluginError,
  requirePluginWorkspace,
  visiblePluginWhere,
} from "./catalog";

/** Drafts have no applied environment to publish; only their selected package pin follows. */
async function followDraftPlugin(
  workspaceId: string,
  userId: string,
  agentId: string,
  installId: string,
  releaseId: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${agentId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
    await requirePluginWorkspace(workspaceId, userId, true, tx);
    const agent = await tx.agent.findFirst({
      where: {
        id: agentId,
        workspaceId,
        runtimeKind: { in: ["pi-sdk", "omp"] },
        retiredAt: null,
        publicRuntimeAllocation: null,
      },
      select: { currentRevisionVersion: true },
    });
    if (!agent) throw new PluginError("not_found", "Agent not found.", 404);
    if (agent.currentRevisionVersion !== 0) return false;
    const install = await tx.marketInstall.findFirst({
      where: {
        id: installId,
        targetWorkspaceId: workspaceId,
        status: "ready",
        currentReleaseId: releaseId,
        listing: {
          ...visiblePluginWhere(workspaceId),
          status: "published",
          releases: { some: { id: releaseId, reviewStatus: "approved" } },
        },
      },
      select: { id: true },
    });
    if (!install)
      throw new PluginError(
        "stale_sync",
        "Plugin update is no longer available.",
      );
    const updated = await tx.agentPiPackage.updateMany({
      where: {
        agentId,
        marketInstallId: installId,
        targetReleaseId: releaseId,
        syncRequestedById: userId,
        syncStatus: "pending",
        agent: { workspaceId },
      },
      data: {
        releaseId,
        syncStatus: "synced",
        targetReleaseId: null,
        syncRequestedById: null,
        syncError: null,
      },
    });
    if (updated.count !== 1)
      throw new PluginError("stale_sync", "Plugin update was superseded.");
    return true;
  });
}

async function syncAgentPlugin(
  workspaceId: string,
  agentId: string,
  installId: string,
) {
  const binding = await db.agentPiPackage.findFirst({
    where: {
      agentId,
      marketInstallId: installId,
      syncStatus: "pending",
      agent: { workspaceId },
      marketInstall: { targetWorkspaceId: workspaceId },
    },
    include: { targetRelease: true, marketInstall: true },
  });
  if (!binding) return;
  const targetReleaseId = binding.targetReleaseId;
  const requestedBy = binding.syncRequestedById;
  const pendingWhere = {
    agentId,
    marketInstallId: installId,
    targetReleaseId,
    syncRequestedById: requestedBy,
    syncStatus: "pending",
    agent: { workspaceId },
  };
  try {
    if (!requestedBy)
      throw new PluginError(
        "not_authorized",
        "The updating administrator no longer exists.",
        403,
      );
    await requirePluginWorkspace(workspaceId, requestedBy, true);
    if (
      !binding.targetRelease ||
      binding.marketInstall.status !== "ready" ||
      binding.marketInstall.currentReleaseId !== targetReleaseId
    )
      throw new PluginError(
        "stale_sync",
        "The plugin update target is no longer current.",
      );
    await withAgentMaintenanceLease(agentId, async () => {
      const [sandboxes, activeTask, activeWork] = await Promise.all([
        db.agentSandbox.findMany({
          where: { agentId, agent: { workspaceId } },
          select: { sandboxId: true },
        }),
        db.a2ATask.findFirst({
          where: {
            context: { agentId, workspaceId },
            state: { notIn: TERMINAL },
          },
          select: { id: true },
        }),
        db.workSession.findFirst({
          where: {
            agentId,
            workspaceId,
            status: {
              in: ["queued", "running", "cancelling"],
            },
          },
          select: { id: true },
        }),
      ]);
      if (
        sandboxes.some(({ sandboxId }) => sandboxExecutionBusy(sandboxId)) ||
        activeTask ||
        activeWork
      )
        throw new AgentExecutionBusyError();
      const release = binding.targetRelease;
      if (!release)
        throw new PluginError(
          "stale_sync",
          "The plugin update target is no longer current.",
        );
      const manifest = parsePiPackageReleaseManifest(
        release.manifest,
        release.checksum,
      );
      const policy = resolvePiPackageMcpPolicy(
        manifest.package.toolplane?.mcp,
        binding.marketInstall.resourceMap,
      );
      if (
        await followDraftPlugin(
          workspaceId,
          requestedBy,
          agentId,
          installId,
          release.id,
        )
      )
        return;
      const connections: AgentPackageMcpConnection[] = [];
      for (const [deploymentId, tools] of Object.entries(policy)) {
        const selected = await db.deployment.findFirst({
          where: { id: deploymentId, workspaceId },
        });
        if (!selected)
          throw new PluginError(
            "tools_unavailable",
            "Plugin MCP deployment is unavailable.",
          );
        const deployment = await ensureWorkspaceMcpDeploymentPinned({
          workspaceId,
          deploymentId,
        });
        connections.push({
          deploymentId,
          allowedToolNames: tools,
          prepared: await prepareSessionMcpDefinition(deployment),
        });
      }
      const current = await pinCurrentAgentRevision(db, agentId);
      await applyPiPackageToAgent({
        workspaceId,
        userId: requestedBy,
        agentId,
        expectedRevisionId: current.id,
        package: {
          marketInstallId: installId,
          releaseId: release.id,
          integrity: release.checksum,
        },
        connections,
        syncTarget: { releaseId: release.id, requestedById: requestedBy },
      });
    });
  } catch (error) {
    await db.agentPiPackage.updateMany({
      where: pendingWhere,
      data: {
        syncStatus:
          error instanceof AgentExecutionBusyError ? "pending" : "failed",
        syncError:
          error instanceof AgentExecutionBusyError
            ? null
            : error instanceof Error
              ? error.message
              : "Plugin synchronization failed.",
      },
    });
  }
}

export async function syncInstallAgents(
  workspaceId: string,
  installId: string,
) {
  const bindings = await db.agentPiPackage.findMany({
    where: {
      marketInstallId: installId,
      syncStatus: "pending",
      agent: { workspaceId },
      marketInstall: { targetWorkspaceId: workspaceId },
    },
    select: { agentId: true },
    orderBy: { agentId: "asc" },
  });
  for (const binding of bindings)
    await syncAgentPlugin(workspaceId, binding.agentId, installId);
}

let retrying = false;
export async function runPendingAgentPluginSyncs() {
  if (retrying) return;
  retrying = true;
  try {
    const pending = await db.agentPiPackage.findMany({
      where: { syncStatus: "pending" },
      select: {
        agentId: true,
        marketInstallId: true,
        agent: { select: { workspaceId: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
    for (const binding of pending)
      await syncAgentPlugin(
        binding.agent.workspaceId,
        binding.agentId,
        binding.marketInstallId,
      );
  } finally {
    retrying = false;
  }
}

export async function approveAgentPluginSync(
  workspaceId: string,
  userId: string,
  agentId: string,
  installId: string,
  expectedTargetReleaseId: string,
) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await requirePluginWorkspace(workspaceId, userId, true, tx);
    const binding = await tx.agentPiPackage.findFirst({
      where: {
        agentId,
        marketInstallId: installId,
        agent: { workspaceId },
        marketInstall: { targetWorkspaceId: workspaceId, status: "ready" },
      },
      include: { marketInstall: { select: { currentReleaseId: true } } },
    });
    if (!binding)
      throw new PluginError("not_found", "Plugin binding not found.", 404);
    if (
      binding.syncStatus !== "review_required" ||
      binding.targetReleaseId !== expectedTargetReleaseId ||
      binding.targetReleaseId !== binding.marketInstall.currentReleaseId
    )
      throw new PluginError(
        "plugin_review_conflict",
        "The plugin review target changed. Refresh and review the current update before approving.",
        409,
      );
    await tx.agentPiPackage.update({
      where: {
        agentId_marketInstallId: { agentId, marketInstallId: installId },
      },
      data: {
        syncStatus: "pending",
        syncRequestedById: userId,
        syncError: null,
      },
    });
  });
  await syncAgentPlugin(workspaceId, agentId, installId);
  return db.agentPiPackage.findFirstOrThrow({
    where: {
      agentId,
      marketInstallId: installId,
      agent: { workspaceId },
      marketInstall: { targetWorkspaceId: workspaceId },
    },
    select: {
      agentId: true,
      marketInstallId: true,
      releaseId: true,
      syncStatus: true,
      targetReleaseId: true,
      syncError: true,
    },
  });
}
