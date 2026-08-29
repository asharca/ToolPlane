import 'server-only';

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { MarketError } from '@/lib/market/skills';

async function publisherListing(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; listingId: string; actorId: string },
) {
  const listing = await tx.marketListing.findFirst({
    where: {
      id: input.listingId,
      publisherWorkspaceId: input.workspaceId,
      publisherWorkspace: {
        is: {
          OR: [
            { ownerId: input.actorId },
            { members: { some: { userId: input.actorId, role: { in: ['owner', 'admin'] } } } },
          ],
        },
      },
    },
    select: {
      id: true,
      kind: true,
      status: true,
      latestReleaseId: true,
      pendingReleaseId: true,
      sourceServerId: true,
      sourceSkillId: true,
      sourceToolkitId: true,
    },
  });
  if (!listing) throw new MarketError('not_authorized', 'Only the publishing workspace can manage this listing.');
  return listing;
}

async function rejectPending(
  tx: Prisma.TransactionClient,
  releaseId: string | null,
  note: string,
) {
  if (!releaseId) return;
  await tx.marketRelease.updateMany({
    where: { id: releaseId, reviewStatus: 'pending' },
    data: { reviewStatus: 'rejected', reviewedAt: new Date(), reviewNote: note },
  });
}

export async function withdrawMarketRelease(input: {
  workspaceId: string;
  listingId: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const listing = await publisherListing(tx, input);
    if (!listing.pendingReleaseId) {
      throw new MarketError('release_not_found', 'This listing has no pending release.');
    }
    await rejectPending(tx, listing.pendingReleaseId, 'Withdrawn by the publisher.');
    return tx.marketListing.update({
      where: { id: listing.id },
      data: {
        pendingReleaseId: null,
        status: listing.latestReleaseId ? listing.status : 'draft',
      },
    });
  });
}

export async function unpublishMarketListing(input: {
  workspaceId: string;
  listingId: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const listing = await publisherListing(tx, input);
    if (!listing.latestReleaseId) {
      throw new MarketError('release_not_found', 'This listing has no published release.');
    }
    await rejectPending(tx, listing.pendingReleaseId, 'Withdrawn because the publisher unpublished the listing.');
    if (listing.sourceServerId) {
      await tx.server.update({ where: { id: listing.sourceServerId }, data: { verifiedAt: null } });
    }
    if (listing.sourceSkillId) {
      await tx.skill.update({ where: { id: listing.sourceSkillId }, data: { curated: false } });
    }
    if (listing.sourceToolkitId) {
      await tx.toolkit.update({ where: { id: listing.sourceToolkitId }, data: { enabled: false } });
    }
    return tx.marketListing.update({
      where: { id: listing.id },
      data: { status: 'disabled', pendingReleaseId: null },
    });
  });
}
