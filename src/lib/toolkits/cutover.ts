import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { assemblePiPackage } from "@/lib/market/pi-package-assembly";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
} from "@/lib/market/pi-package-manifest";
import { MarketError } from "@/lib/market/skills";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { revokeToolkitInstallTokens } from "./install-link";
import { writeAudit } from "@/lib/observability/audit";

export type ToolkitCutoverInput = {
  workspaceId: string;
  userId: string;
  toolkitId: string;
} & (
  | { mode: "dry-run" }
  | { mode: "apply"; expectedDigest: string; confirmReauthorization: true }
);

/** Controlled, drained cutover. This operation never installs or authorizes the frozen package. */
export async function cutoverToolkitToPrivatePackage(
  input: ToolkitCutoverInput,
) {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      const user = await tx.user.findFirst({
        where: { id: input.userId, status: "active" },
        select: { role: true },
      });
      const workspace = await tx.workspace.findFirst({
        where: {
          id: input.workspaceId,
          status: "active",
          OR: [
            { ownerId: input.userId },
            {
              members: {
                some: {
                  userId: input.userId,
                  role: { in: ["owner", "admin"] },
                },
              },
            },
            ...(user?.role === "admin" ? [{}] : []),
          ],
        },
        select: { id: true, slug: true, name: true },
      });
      if (!user || !workspace)
        throw new MarketError(
          "not_authorized",
          "Workspace or platform administrator authorization is required.",
        );
      const toolkit = await tx.toolkit.findFirst({
        where: { id: input.toolkitId, workspaceId: workspace.id },
        include: {
          sourceMarketListing: { include: { latestRelease: true } },
          skills: true,
          servers: {
            include: {
              deployment: {
                select: {
                  id: true,
                  installCfg: true,
                  mcpToolExposure: true,
                  mcpAllowedTools: true,
                },
              },
            },
          },
        },
      });
      if (!toolkit)
        throw new MarketError(
          "source_not_found",
          "Toolkit not found in this workspace.",
        );
      if (toolkit.sourceMarketListing?.kind === "pi-package") {
        return {
          mode: input.mode,
          status: "already-applied" as const,
          listingId: toolkit.sourceMarketListing.id,
          releaseId: toolkit.sourceMarketListing.latestReleaseId,
          digest: toolkit.sourceMarketListing.latestRelease?.checksum ?? null,
          requiresReauthorization: true as const,
          blockers: [] as string[],
        };
      }
      const [work, runs, a2a] = await Promise.all([
        tx.workSession.count({
          where: {
            workspaceId: workspace.id,
            completedAt: null,
            agent: { toolkits: { some: { toolkitId: toolkit.id } } },
          },
        }),
        tx.agentRun.count({
          where: {
            completedAt: null,
            endpoint: {
              sourceAgent: {
                workspaceId: workspace.id,
                toolkits: { some: { toolkitId: toolkit.id } },
              },
            },
          },
        }),
        tx.a2ATask.count({
          where: {
            completedAt: null,
            context: {
              workspaceId: workspace.id,
              agent: { toolkits: { some: { toolkitId: toolkit.id } } },
            },
          },
        }),
      ]);
      const blockers: string[] = [];
      if (work + runs + a2a) blockers.push("active_legacy_tasks");
      const mcps = toolkit.servers.map(({ deployment }) => ({
        deploymentId: deployment.id,
        tools: readMcpToolCatalog(deployment.installCfg)
          .map((tool) => tool.name)
          .filter(
            (name) =>
              deployment.mcpToolExposure !== "allowlist" ||
              deployment.mcpAllowedTools.includes(name),
          ),
      }));
      if (mcps.some((mcp) => !mcp.tools.length))
        blockers.push("mcp_catalog_unavailable");
      if (!toolkit.skills.length && !mcps.length)
        blockers.push("no_convertible_content");
      if (blockers.some((blocker) => blocker !== "active_legacy_tasks")) {
        if (input.mode === "apply")
          throw new MarketError(
            "invalid_manifest",
            `Toolkit cannot be converted: ${blockers.join(", ")}`,
          );
        return {
          mode: input.mode,
          status: "blocked" as const,
          digest: null,
          blockers,
          requiresReauthorization: true as const,
        };
      }
      const { snapshot } = await assemblePiPackage(tx, {
        workspaceId: workspace.id,
        name: `toolkit-${toolkit.slug}`,
        version: "1.0.0",
        installedSkillIds: toolkit.skills.map(
          (skill) => skill.installedSkillId,
        ),
        mcps,
      });
      const digest = marketReleaseChecksum(snapshot);
      const slug = `toolkit-${createHash("sha256").update(toolkit.id).digest("hex").slice(0, 20)}`;
      const manifest = parsePiPackageReleaseManifest({
        schemaVersion: 1,
        kind: "pi-package",
        package: snapshot,
        listing: {
          slug,
          name: toolkit.name,
          summary:
            "Private frozen Toolkit conversion; fresh authorization required.",
          iconUrl: null,
          tags: [],
          author: workspace.name,
        },
      });
      const scanResult = scanPiPackageReleaseManifest(manifest);
      if (scanResult.status === "blocked")
        throw new MarketError(
          "invalid_manifest",
          "Convertible content contains possible credentials.",
        );
      if (input.mode === "dry-run")
        return {
          mode: input.mode,
          status: blockers.length ? ("blocked" as const) : ("ready" as const),
          digest,
          blockers,
          requiresReauthorization: true as const,
          resources: snapshot.resources,
          mcpRequirements: snapshot.toolplane?.mcp ?? [],
        };
      if (blockers.length)
        throw new MarketError(
          "in_use",
          "Drain all active legacy tasks before applying Toolkit cutover.",
        );
      if (
        input.confirmReauthorization !== true ||
        input.expectedDigest !== digest
      )
        throw new MarketError(
          "source_changed",
          "Explicitly confirm the exact dry-run digest and fresh authorization requirement.",
        );
      if (toolkit.sourceMarketListing)
        await tx.marketListing.update({
          where: { id: toolkit.sourceMarketListing.id },
          data: { sourceToolkitId: null, status: "archived" },
        });
      const listing = await tx.marketListing.create({
        data: {
          kind: "pi-package",
          namespace: workspace.slug,
          slug,
          name: toolkit.name,
          visibility: "private",
          status: "published",
          publisherKind: "workspace",
          publisherWorkspaceId: workspace.id,
          publishedById: input.userId,
          sourceToolkitId: toolkit.id,
          tags: [],
          metadata: {
            cutover: {
              toolkitId: toolkit.id,
              sourceDigest: digest,
              requiresReauthorization: true,
            },
          },
        },
      });
      const now = new Date();
      const release = await tx.marketRelease.create({
        data: {
          listingId: listing.id,
          version: 1,
          manifest: manifest as Prisma.InputJsonValue,
          checksum: marketReleaseChecksum(manifest),
          scanResult: scanResult as Prisma.InputJsonValue,
          reviewStatus: "approved",
          publishedAt: now,
          releaseSummary: {
            reviewPolicy: "workspace-owner-trust",
            migration: "toolkit-private-freeze",
            sourceDigest: digest,
            requiresReauthorization: true,
          },
        },
      });
      await tx.marketListing.update({
        where: { id: listing.id },
        data: {
          latestVersion: 1,
          latestReleaseId: release.id,
          publishedAt: now,
        },
      });
      await revokeToolkitInstallTokens(toolkit.id, tx);
      await tx.toolkitInstallation.updateMany({
        where: { toolkitId: toolkit.id },
        data: { status: "revoked" },
      });
      await tx.toolkit.update({
        where: { id: toolkit.id },
        data: { enabled: false, visibility: "private" },
      });
      await writeAudit(tx, {
        actorId: input.userId,
        workspaceId: workspace.id,
        action: "toolkit.cutover.private-freeze",
        targetType: "toolkit",
        targetId: toolkit.id,
        changes: {
          listingId: listing.id,
          releaseId: release.id,
          sourceDigest: digest,
          requiresReauthorization: true,
        },
      });
      return {
        mode: input.mode,
        status: "applied" as const,
        listingId: listing.id,
        releaseId: release.id,
        digest,
        blockers,
        requiresReauthorization: true as const,
      };
    },
    { isolationLevel: "Serializable", timeout: 30_000 },
  );
}
