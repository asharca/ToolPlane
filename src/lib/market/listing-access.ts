import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type MarketViewer = { workspaceId: string; userId: string };

export async function visibleListings(
  viewer?: MarketViewer,
): Promise<Prisma.MarketListingWhereInput> {
  if (!viewer) return { visibility: "public" };
  const workspace = await db.workspace.findFirst({
    where: {
      id: viewer.workspaceId,
      status: "active",
      OR: [
        { ownerId: viewer.userId },
        { members: { some: { userId: viewer.userId } } },
      ],
    },
    select: { id: true },
  });
  return workspace
    ? {
        OR: [
          { visibility: "public" },
          { visibility: "private", publisherWorkspaceId: workspace.id },
        ],
      }
    : { visibility: "public" };
}
