import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { PluginError } from "@/lib/plugins/catalog";

/** Called at execution boundaries as well as admission: immutable pins never bypass revocation. */
export async function assertMarketReleasesExecutable(
  tx: Prisma.TransactionClient,
  releaseIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(releaseIds)];
  if (!ids.length) return;
  const available = await tx.marketRelease.count({
    where: {
      id: { in: ids },
      reviewStatus: "approved",
      listing: { status: { in: ["published", "removed"] } },
    },
  });
  if (available !== ids.length)
    throw new PluginError(
      "listing_unavailable",
      "A pinned capability release is unavailable or security-revoked.",
    );
}

/** Security revocation is not uninstall: references and readable history remain intact. */
export async function revokeDangerousMarketRelease(input: {
  workspaceId: string;
  userId: string;
  releaseId: string;
  reason: string;
}) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000)
    throw new PluginError(
      "invalid_manifest",
      "Provide a revocation reason of at most 2000 characters.",
    );
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      const actor = await tx.user.findFirst({
        where: { id: input.userId, status: "active" },
        select: { role: true },
      });
      const release = await tx.marketRelease.findUnique({
        where: { id: input.releaseId },
        include: { listing: true },
      });
      if (!actor || !release || actor.role !== "admin")
        throw new PluginError(
          "not_authorized",
          "Only a platform administrator can revoke this release.",
          403,
        );
      if (release.reviewStatus === "revoked")
        return {
          releaseId: release.id,
          status: "revoked" as const,
          changed: false,
        };
      await tx.marketRelease.update({
        where: { id: release.id },
        data: {
          reviewStatus: "revoked",
          reviewedById: input.userId,
          reviewedAt: new Date(),
          reviewNote: reason,
        },
      });
      await writeAudit(tx, {
        actorId: input.userId,
        workspaceId: input.workspaceId,
        action: "market.release.security-revoked",
        targetType: "marketRelease",
        targetId: release.id,
        changes: { previousStatus: release.reviewStatus, status: "revoked" },
      });
      return {
        releaseId: release.id,
        status: "revoked" as const,
        changed: true,
      };
    },
    { isolationLevel: "Serializable" },
  );
}
