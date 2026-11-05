import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { removeAgentRevisionPackageInTransaction } from "@/lib/agents/revisions";
import { readCapabilities, requiresReview } from "./capabilities";
import {
  PluginError,
  requirePluginWorkspace,
  visiblePluginWhere,
} from "./catalog";
import { syncInstallAgents } from "./agent-sync";

export const pluginMcpBindingsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    z
      .object({
        deploymentId: z.string().min(1).max(240),
        tools: z.array(z.string().min(1).max(256)).max(256),
      })
      .strict(),
  )
  .refine((bindings) => Object.keys(bindings).length <= 64);
export type PluginMcpBindings = z.infer<typeof pluginMcpBindingsSchema>;

export async function validatePluginBindings(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  release: { manifest: unknown; checksum: string },
  value: unknown,
) {
  const parsed = pluginMcpBindingsSchema.safeParse(value);
  if (!parsed.success)
    throw new PluginError("invalid_bindings", "Invalid plugin MCP bindings.");
  const bindings = parsed.data;
  const requirements =
    parsePiPackageReleaseManifest(release.manifest, release.checksum).package
      .toolplane?.mcp ?? [];
  if (
    Object.keys(bindings).some(
      (key) => !requirements.some((item) => item.key === key),
    )
  )
    throw new PluginError(
      "invalid_bindings",
      "Unknown plugin MCP requirement.",
    );
  for (const requirement of requirements) {
    const binding = bindings[requirement.key];
    if (
      !binding ||
      new Set(binding.tools).size !== binding.tools.length ||
      binding.tools.length !== requirement.tools.length ||
      requirement.tools.some((tool) => !binding.tools.includes(tool))
    )
      throw new PluginError(
        "invalid_bindings",
        "Every required MCP tool must be explicitly bound.",
      );
    const deployment = await tx.deployment.findFirst({
      where: { id: binding.deploymentId, workspaceId },
      select: {
        installCfg: true,
        mcpToolExposure: true,
        mcpAllowedTools: true,
      },
    });
    const available = new Set(
      deployment
        ? readMcpToolCatalog(deployment.installCfg).map((tool) => tool.name)
        : [],
    );
    if (
      !deployment ||
      binding.tools.some(
        (tool) =>
          !available.has(tool) ||
          (deployment.mcpToolExposure === "allowlist" &&
            !deployment.mcpAllowedTools.includes(tool)),
      )
    )
      throw new PluginError(
        "tools_unavailable",
        "Selected MCP tools are unavailable.",
      );
  }
  return bindings;
}

function storedBindings(resourceMap: unknown): unknown {
  return resourceMap &&
    typeof resourceMap === "object" &&
    !Array.isArray(resourceMap)
    ? ((resourceMap as Record<string, unknown>).mcpBindings ?? {})
    : {};
}

export async function addPlugin(
  workspaceId: string,
  userId: string,
  listingId: string,
  mcpBindings: PluginMcpBindings = {},
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(workspaceId, userId, true, tx);
      const listing = await tx.marketListing.findFirst({
        where: {
          id: listingId,
          ...visiblePluginWhere(workspaceId),
          status: "published",
        },
        include: {
          releases: {
            where: { reviewStatus: "approved" },
            orderBy: { version: "desc" },
            take: 1,
          },
        },
      });
      const release = listing?.releases[0];
      if (!listing || !release)
        throw new PluginError("not_found", "Published plugin not found.", 404);
      const existing = await tx.marketInstall.findFirst({
        where: { listingId, targetWorkspaceId: workspaceId },
      });
      if (existing && existing.status !== "uninstalled") return existing;
      const bindings = await validatePluginBindings(
        tx,
        workspaceId,
        release,
        mcpBindings,
      );
      const data = {
        currentReleaseId: release.id,
        installedById: userId,
        resourceMap: { kind: "pi-package", mcpBindings: bindings },
        status: "ready",
        lastError: null,
      };
      const install = existing
        ? await tx.marketInstall.update({
            where: { id: existing.id, targetWorkspaceId: workspaceId },
            data,
          })
        : await tx.marketInstall.create({
            data: {
              ...data,
              listingId,
              targetWorkspaceId: workspaceId,
              idempotencyKey: `plugin:${workspaceId}:${listingId}`,
            },
          });
      await tx.marketListing.update({
        where: { id: listingId },
        data: { installCount: { increment: 1 } },
      });
      return install;
    },
    { timeout: 120_000 },
  );
}

export async function updatePlugin(
  workspaceId: string,
  userId: string,
  installId: string,
  targetReleaseId: string,
  mcpBindings?: PluginMcpBindings,
) {
  const install = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(workspaceId, userId, true, tx);
      const current = await tx.marketInstall.findFirst({
        where: {
          id: installId,
          targetWorkspaceId: workspaceId,
          status: "ready",
          listing: { ...visiblePluginWhere(workspaceId), status: "published" },
        },
      });
      if (!current)
        throw new PluginError(
          "not_found",
          "Plugin installation not found.",
          404,
        );
      const release = await tx.marketRelease.findFirst({
        where: {
          id: targetReleaseId,
          listingId: current.listingId,
          reviewStatus: "approved",
        },
      });
      if (!release)
        throw new PluginError(
          "not_found",
          "Approved plugin release not found.",
          404,
        );
      const bindings = await validatePluginBindings(
        tx,
        workspaceId,
        release,
        mcpBindings ?? storedBindings(current.resourceMap),
      );
      const updated = await tx.marketInstall.update({
        where: { id: installId, targetWorkspaceId: workspaceId },
        data: {
          currentReleaseId: release.id,
          resourceMap: { kind: "pi-package", mcpBindings: bindings },
          lastError: null,
        },
      });
      const agents = await tx.agentPiPackage.findMany({
        where: { marketInstallId: installId, agent: { workspaceId } },
        include: { release: { select: { releaseSummary: true } } },
      });
      for (const binding of agents) {
        const review =
          binding.releaseId !== release.id &&
          requiresReview(
            readCapabilities(binding.release.releaseSummary),
            readCapabilities(release.releaseSummary),
          );
        await tx.agentPiPackage.update({
          where: {
            agentId_marketInstallId: {
              agentId: binding.agentId,
              marketInstallId: installId,
            },
          },
          data: {
            targetReleaseId: release.id,
            syncRequestedById: userId,
            syncStatus: review ? "review_required" : "pending",
            syncError: null,
          },
        });
      }
      return updated;
    },
    { timeout: 120_000 },
  );
  await syncInstallAgents(workspaceId, installId);
  return install;
}

/** Uninstall narrows defaults; immutable revisions and existing sessions retain their pins. */
export async function removePlugin(
  workspaceId: string,
  userId: string,
  installId: string,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(workspaceId, userId, true, tx);
      const install = await tx.marketInstall.findFirst({
        where: { id: installId, targetWorkspaceId: workspaceId },
      });
      if (!install)
        throw new PluginError(
          "not_found",
          "Plugin installation not found.",
          404,
        );
      const agents = await tx.agent.findMany({
        where: {
          workspaceId,
          runtimeKind: { in: ["pi-sdk"] },
          retiredAt: null,
          currentRevisionVersion: { gt: 0 },
        },
        select: { id: true, currentRevisionVersion: true },
        orderBy: { id: "asc" },
      });
      for (const agent of agents) {
        const current = await tx.agentRevision.findUniqueOrThrow({
          where: {
            agentId_version: {
              agentId: agent.id,
              version: agent.currentRevisionVersion,
            },
          },
        });
        const config = AgentRevisionConfigSchema.parse(current.config);
        if (config.packages.some((pin) => pin.marketInstallId === installId))
          await removeAgentRevisionPackageInTransaction(
            tx,
            workspaceId,
            agent.id,
            current.id,
            installId,
          );
      }
      await tx.agentPiPackage.deleteMany({
        where: { marketInstallId: installId, agent: { workspaceId } },
      });
      await tx.marketInstall.update({
        where: { id: installId, targetWorkspaceId: workspaceId },
        data: { status: "uninstalled" },
      });
      if (install.status !== "uninstalled")
        await tx.marketListing.updateMany({
          where: { id: install.listingId, installCount: { gt: 0 } },
          data: { installCount: { decrement: 1 } },
        });
      return { id: installId };
    },
    { timeout: 120_000 },
  );
}
