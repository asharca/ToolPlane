import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SITE } from "@/lib/site";

/** Cutover-only credential retirement; no Toolkit registration or execution issuer remains. */
export async function revokeToolkitInstallTokens(
  toolkitId: string,
  tx: Prisma.TransactionClient = db,
): Promise<void> {
  const toolkit = await tx.toolkit.findUnique({
    where: { id: toolkitId },
    select: { slug: true, installLinks: { select: { userId: true } } },
  });
  if (!toolkit) return;
  const userIds = [...new Set(toolkit.installLinks.map((link) => link.userId))];
  const brands = [...new Set([SITE.compactName, "MCPmarket"])];
  await tx.apiToken.deleteMany({
    where: {
      OR: [
        { toolkitId },
        ...(userIds.length
          ? brands.map((brand) => ({
              toolkitId: null,
              userId: { in: userIds },
              name: { startsWith: `${brand} plugin - ${toolkit.slug} (` },
            }))
          : []),
      ],
    },
  });
}
