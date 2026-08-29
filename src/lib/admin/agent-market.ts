import 'server-only';

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import {
  AGENT_MARKET_MANIFEST_VERSION,
  AgentMarketError,
  agentReleaseChecksum,
  buildCatalogAgentManifest,
  parseAgentReleaseManifest,
  summarizeAgentReleaseManifest,
  type AgentReleaseManifestV1,
} from '@/lib/agents/market';
import { scanAgentReleaseManifest } from '@/lib/market/secret-scan';

const PAGE_SIZE = 25;

export const ADMIN_AGENT_LISTING_STATUSES = ['draft', 'published', 'disabled'] as const;
export type AdminAgentListingStatus = (typeof ADMIN_AGENT_LISTING_STATUSES)[number];

export type AgentListingMetadataInput = {
  directorySlug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  curated: boolean;
  isFeatured: boolean;
  categoryIds: string[];
  status: AdminAgentListingStatus;
};

export type CatalogAgentConfigInput = {
  systemPrompt: string | null;
  maxSteps: number;
  modelFormat: string | null;
  model: string | null;
  serverIds: string[];
  skillIds: string[];
};

export type DirectoryAgentTemplateInput = AgentListingMetadataInput & CatalogAgentConfigInput;

export type UpdateDirectoryAgentInput = AgentListingMetadataInput & {
  config?: CatalogAgentConfigInput;
};

export class AdminAgentMarketError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'slug_conflict'
      | 'release_not_found'
      | 'release_not_pending'
      | 'pending_release_exists'
      | 'invalid_config'
      | 'invalid_release'
      | 'invalid_categories'
      | 'publish_without_release'
      | 'orphaned_publisher'
      | 'installed',
    message: string,
    readonly count?: number,
  ) {
    super(message);
    this.name = 'AdminAgentMarketError';
  }
}

function isPrismaUniqueError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'P2002',
  );
}

function isPrismaForeignKeyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'P2003',
  );
}

export function normalizeAgentListingTags(values: readonly string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().toLocaleLowerCase().slice(0, 40))
    .filter(Boolean))]
    .slice(0, 20);
}

async function checkedCategoryIds(
  tx: Prisma.TransactionClient,
  values: readonly string[],
): Promise<string[]> {
  const categoryIds = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (categoryIds.length === 0 || categoryIds.length > 20) {
    throw new AdminAgentMarketError('invalid_categories', 'Select at least one valid category.');
  }
  const count = await tx.category.count({ where: { id: { in: categoryIds } } });
  if (count !== categoryIds.length) {
    throw new AdminAgentMarketError('invalid_categories', 'One or more selected categories do not exist.');
  }
  return categoryIds;
}

function assertPublishableOrigin(listing: {
  publisherKind: string;
  publisherWorkspaceId: string | null;
}) {
  if (listing.publisherKind === 'workspace' && !listing.publisherWorkspaceId) {
    throw new AdminAgentMarketError(
      'orphaned_publisher',
      'The publisher workspace no longer exists. Disable this listing instead of publishing it.',
    );
  }
}

export async function listDirectoryAgentListings({
  page = 1,
  q = '',
  status,
}: {
  page?: number;
  q?: string;
  status?: AdminAgentListingStatus;
}) {
  const currentPage = normalizeAdminPage(page);
  const term = q.trim().slice(0, 200);
  const where: Prisma.AgentListingWhereInput = {
    ...(status ? { status } : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { directorySlug: { contains: term, mode: 'insensitive' } },
            { author: { contains: term, mode: 'insensitive' } },
            { publisherWorkspace: { name: { contains: term, mode: 'insensitive' } } },
            { publisherWorkspace: { slug: { contains: term, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.agentListing.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: PAGE_SIZE,
      select: {
        id: true,
        directorySlug: true,
        name: true,
        author: true,
        status: true,
        curated: true,
        isFeatured: true,
        latestVersion: true,
        installCount: true,
        updatedAt: true,
        publisherKind: true,
        publisherWorkspaceId: true,
        publisherWorkspace: { select: { slug: true, name: true } },
        pendingRelease: { select: { id: true, version: true, publishedAt: true } },
        _count: { select: { releases: true } },
      },
    }),
    db.agentListing.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

const RELEASE_ADMIN_SELECT = {
  id: true,
  version: true,
  manifestVersion: true,
  manifest: true,
  releaseSummary: true,
  checksum: true,
  name: true,
  summary: true,
  iconUrl: true,
  tags: true,
  categoryIds: true,
  reviewStatus: true,
  reviewedById: true,
  reviewedAt: true,
  reviewNote: true,
  publishedAt: true,
  reviewedBy: { select: { id: true, email: true, name: true } },
  _count: { select: { installs: true } },
} satisfies Prisma.AgentReleaseSelect;

export function getDirectoryAgentListing(id: string) {
  return db.agentListing.findUnique({
    where: { id },
    include: {
      categories: { select: { id: true, slug: true, name: true } },
      publisherWorkspace: { select: { id: true, slug: true, name: true } },
      publishedBy: { select: { id: true, email: true, name: true } },
      latestRelease: { select: RELEASE_ADMIN_SELECT },
      pendingRelease: { select: RELEASE_ADMIN_SELECT },
      releases: {
        orderBy: { version: 'desc' },
        take: 20,
        select: {
          id: true,
          version: true,
          reviewStatus: true,
          reviewedAt: true,
          publishedAt: true,
          checksum: true,
          _count: { select: { installs: true } },
        },
      },
      _count: { select: { releases: true } },
    },
  });
}

export async function listCatalogAgentResources() {
  const [servers, skills] = await Promise.all([
    db.server.findMany({
      where: { verifiedAt: { not: null }, installCfg: { not: Prisma.DbNull } },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true },
    }),
    db.skill.findMany({
      where: { curated: true },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true },
    }),
  ]);
  return { servers, skills };
}

async function buildReleaseArtifact(
  tx: Prisma.TransactionClient,
  metadata: Pick<AgentListingMetadataInput, 'directorySlug' | 'name' | 'summary' | 'iconUrl' | 'tags'>,
  config: CatalogAgentConfigInput,
): Promise<{
  manifest: AgentReleaseManifestV1;
  releaseSummary: ReturnType<typeof summarizeAgentReleaseManifest>;
  checksum: string;
}> {
  let manifest: AgentReleaseManifestV1;
  try {
    manifest = await buildCatalogAgentManifest(tx, {
      name: metadata.name,
      slug: metadata.directorySlug,
      systemPrompt: config.systemPrompt,
      maxSteps: config.maxSteps,
      modelFormat: config.modelFormat,
      model: config.model,
      serverIds: config.serverIds,
      skillIds: config.skillIds,
    });
  } catch (error) {
    if (error instanceof AgentMarketError) {
      throw new AdminAgentMarketError('invalid_config', error.message);
    }
    throw error;
  }
  const scan = scanAgentReleaseManifest(manifest, metadata.summary);
  if (scan.status === 'blocked') {
    throw new AdminAgentMarketError(
      'invalid_config',
      'Remove possible credentials from the agent before publishing it.',
    );
  }
  return {
    manifest,
    releaseSummary: summarizeAgentReleaseManifest(manifest),
    checksum: agentReleaseChecksum(manifest),
  };
}

export async function createDirectoryAgentTemplate(
  input: DirectoryAgentTemplateInput,
  reviewedById: string,
) {
  try {
    return await db.$transaction(async (tx) => {
      const categoryIds = await checkedCategoryIds(tx, input.categoryIds);
      const artifact = await buildReleaseArtifact(tx, input, input);
      const listing = await tx.agentListing.create({
        data: {
          publisherKind: 'platform',
          publisherWorkspaceId: null,
          publishedById: null,
          sourceAgentId: null,
          slug: input.directorySlug,
          directorySlug: input.directorySlug,
          name: input.name,
          author: input.author,
          summary: input.summary,
          iconUrl: input.iconUrl,
          tags: normalizeAgentListingTags(input.tags),
          status: input.status,
          curated: input.curated,
          isFeatured: input.isFeatured,
          categories: { connect: categoryIds.map((id) => ({ id })) },
        },
        select: { id: true },
      });
      const release = await tx.agentRelease.create({
        data: {
          listingId: listing.id,
          version: 1,
          manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
          manifest: artifact.manifest as Prisma.InputJsonValue,
          releaseSummary: artifact.releaseSummary as Prisma.InputJsonValue,
          checksum: artifact.checksum,
          name: input.name,
          summary: input.summary,
          iconUrl: input.iconUrl,
          tags: normalizeAgentListingTags(input.tags),
          categoryIds,
          reviewStatus: 'approved',
          reviewedById,
          reviewedAt: new Date(),
          reviewNote: 'Created by an administrator.',
        },
        select: { id: true, publishedAt: true },
      });
      await tx.agentListing.update({
        where: { id: listing.id },
        data: {
          latestVersion: 1,
          latestReleaseId: release.id,
          publishedAt: input.status === 'published' ? release.publishedAt : null,
        },
      });
      return { id: listing.id, releaseId: release.id };
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (isPrismaUniqueError(error)) {
      throw new AdminAgentMarketError('slug_conflict', 'An agent directory entry already uses this slug.');
    }
    throw error;
  }
}

async function nextReleaseVersion(tx: Prisma.TransactionClient, listingId: string): Promise<number> {
  const aggregate = await tx.agentRelease.aggregate({
    where: { listingId },
    _max: { version: true },
  });
  return (aggregate._max.version ?? 0) + 1;
}

export async function updateDirectoryAgentListing(
  id: string,
  input: UpdateDirectoryAgentInput,
  reviewedById: string,
) {
  try {
    return await db.$transaction(async (tx) => {
      const categoryIds = await checkedCategoryIds(tx, input.categoryIds);
      const existing = await tx.agentListing.findUnique({
        where: { id },
        select: {
          id: true,
          publisherKind: true,
          publisherWorkspaceId: true,
          latestReleaseId: true,
          pendingReleaseId: true,
          publishedAt: true,
          latestRelease: {
            select: {
              checksum: true,
              reviewStatus: true,
              name: true,
              summary: true,
              iconUrl: true,
              tags: true,
            },
          },
        },
      });
      if (!existing) throw new AdminAgentMarketError('not_found', 'Agent listing not found.');
      if (input.status === 'published') assertPublishableOrigin(existing);

      const tags = normalizeAgentListingTags(input.tags);
      let releaseId = existing.latestReleaseId;
      let releaseApproved = existing.latestRelease?.reviewStatus === 'approved';
      let latestVersion: number | undefined;
      let publishedAt = input.status === 'published' ? existing.publishedAt ?? new Date() : existing.publishedAt;

      if (input.config) {
        if (existing.pendingReleaseId) {
          throw new AdminAgentMarketError(
            'pending_release_exists',
            'Review the pending publisher release before changing the approved configuration.',
          );
        }
        const artifact = await buildReleaseArtifact(tx, input, input.config);
        const metadataChanged = !existing.latestRelease
          || existing.latestRelease.name !== input.name
          || existing.latestRelease.summary !== input.summary
          || existing.latestRelease.iconUrl !== input.iconUrl
          || JSON.stringify(existing.latestRelease.tags) !== JSON.stringify(tags);
        if (!existing.latestRelease || existing.latestRelease.checksum !== artifact.checksum || metadataChanged) {
          latestVersion = await nextReleaseVersion(tx, id);
          const release = await tx.agentRelease.create({
            data: {
              listingId: id,
              version: latestVersion,
              manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
              manifest: artifact.manifest as Prisma.InputJsonValue,
              releaseSummary: artifact.releaseSummary as Prisma.InputJsonValue,
              checksum: artifact.checksum,
              name: input.name,
              summary: input.summary,
              iconUrl: input.iconUrl,
              tags,
              categoryIds,
              reviewStatus: 'approved',
              reviewedById,
              reviewedAt: new Date(),
              reviewNote: 'Updated by an administrator.',
            },
            select: { id: true, publishedAt: true },
          });
          releaseId = release.id;
          releaseApproved = true;
          if (input.status === 'published') publishedAt = release.publishedAt;
        }
      }

      if (input.status === 'published' && (!releaseId || !releaseApproved)) {
        throw new AdminAgentMarketError(
          'publish_without_release',
          'An agent listing needs an approved release before it can be published.',
        );
      }

      const updated = await tx.agentListing.update({
        where: { id },
        data: {
          directorySlug: input.directorySlug,
          name: input.name,
          author: input.author,
          summary: input.summary,
          iconUrl: input.iconUrl,
          tags,
          curated: input.curated,
          isFeatured: input.isFeatured,
          status: input.status,
          categories: { set: categoryIds.map((categoryId) => ({ id: categoryId })) },
          ...(releaseId ? { latestReleaseId: releaseId } : {}),
          ...(latestVersion ? { latestVersion } : {}),
          publishedAt,
        },
        select: { id: true, directorySlug: true, status: true },
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error instanceof AdminAgentMarketError) throw error;
    if (isPrismaUniqueError(error)) {
      throw new AdminAgentMarketError('slug_conflict', 'An agent directory entry already uses this slug.');
    }
    throw error;
  }
}

export async function approvePendingAgentRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
  categoryIds?: string[];
}) {
  return db.$transaction(async (tx) => {
    const listing = await tx.agentListing.findUnique({
      where: { id: input.listingId },
      select: {
        id: true,
        publisherKind: true,
        publisherWorkspaceId: true,
        pendingReleaseId: true,
      },
    });
    if (!listing) throw new AdminAgentMarketError('not_found', 'Agent listing not found.');
    assertPublishableOrigin(listing);
    if (listing.pendingReleaseId !== input.releaseId) {
      throw new AdminAgentMarketError('release_not_pending', 'This release is no longer pending review.');
    }
    const release = await tx.agentRelease.findFirst({
      where: { id: input.releaseId, listingId: input.listingId },
      select: {
        id: true,
        version: true,
        reviewStatus: true,
        publishedAt: true,
        name: true,
        summary: true,
        iconUrl: true,
        tags: true,
        categoryIds: true,
        manifestVersion: true,
        manifest: true,
        checksum: true,
      },
    });
    if (!release) throw new AdminAgentMarketError('release_not_found', 'Agent release not found.');
    if (release.reviewStatus !== 'pending') {
      throw new AdminAgentMarketError('release_not_pending', 'This release is no longer pending review.');
    }

    let manifest: AgentReleaseManifestV1;
    try {
      if (release.manifestVersion !== AGENT_MARKET_MANIFEST_VERSION) throw new Error('Unsupported version.');
      manifest = parseAgentReleaseManifest(release.manifest, release.checksum);
    } catch {
      throw new AdminAgentMarketError(
        'invalid_release',
        'The pending release manifest or checksum is invalid.',
      );
    }

    const scan = scanAgentReleaseManifest(manifest, release.summary);
    if (scan.status === 'blocked') {
      throw new AdminAgentMarketError(
        'invalid_release',
        'The pending release contains possible credentials.',
      );
    }
    const categoryIds = await checkedCategoryIds(tx, input.categoryIds ?? release.categoryIds);

    const reviewedAt = new Date();
    await tx.agentRelease.update({
      where: { id: release.id },
      data: {
        reviewStatus: 'approved',
        categoryIds,
        releaseSummary: summarizeAgentReleaseManifest(manifest) as Prisma.InputJsonValue,
        reviewedById: input.reviewedById,
        reviewedAt,
        reviewNote: input.reviewNote?.trim() || null,
      },
    });
    return tx.agentListing.update({
      where: { id: listing.id },
      data: {
        name: release.name,
        summary: release.summary,
        iconUrl: release.iconUrl,
        tags: release.tags,
        status: 'published',
        curated: true,
        latestVersion: release.version,
        latestReleaseId: release.id,
        pendingReleaseId: null,
        publishedAt: reviewedAt,
        categories: { set: categoryIds.map((id) => ({ id })) },
      },
      select: { id: true, directorySlug: true, status: true },
    });
  }, { isolationLevel: 'Serializable' });
}

export async function rejectPendingAgentRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const listing = await tx.agentListing.findUnique({
      where: { id: input.listingId },
      select: { id: true, pendingReleaseId: true, latestReleaseId: true, status: true },
    });
    if (!listing) throw new AdminAgentMarketError('not_found', 'Agent listing not found.');
    if (listing.pendingReleaseId !== input.releaseId) {
      throw new AdminAgentMarketError('release_not_pending', 'This release is no longer pending review.');
    }
    const release = await tx.agentRelease.findFirst({
      where: { id: input.releaseId, listingId: input.listingId },
      select: { id: true, reviewStatus: true },
    });
    if (!release) throw new AdminAgentMarketError('release_not_found', 'Agent release not found.');
    if (release.reviewStatus !== 'pending') {
      throw new AdminAgentMarketError('release_not_pending', 'This release is no longer pending review.');
    }

    await tx.agentRelease.update({
      where: { id: release.id },
      data: {
        reviewStatus: 'rejected',
        reviewedById: input.reviewedById,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote?.trim() || null,
      },
    });
    return tx.agentListing.update({
      where: { id: listing.id },
      data: {
        pendingReleaseId: null,
        status: listing.latestReleaseId ? listing.status : 'draft',
      },
      select: { id: true, directorySlug: true, status: true },
    });
  }, { isolationLevel: 'Serializable' });
}

export async function setDirectoryAgentListingStatus(
  id: string,
  status: 'published' | 'disabled',
) {
  return db.$transaction(async (tx) => {
    const listing = await tx.agentListing.findUnique({
      where: { id },
      select: {
        id: true,
        publisherKind: true,
        publisherWorkspaceId: true,
        latestReleaseId: true,
        publishedAt: true,
        latestRelease: { select: { reviewStatus: true } },
        _count: { select: { categories: true } },
      },
    });
    if (!listing) throw new AdminAgentMarketError('not_found', 'Agent listing not found.');
    if (status === 'published') assertPublishableOrigin(listing);
    if (
      status === 'published'
      && (!listing.latestReleaseId || listing.latestRelease?.reviewStatus !== 'approved')
    ) {
      throw new AdminAgentMarketError(
        'publish_without_release',
        'An agent listing needs an approved release before it can be published.',
      );
    }
    if (status === 'published' && listing._count.categories === 0) {
      throw new AdminAgentMarketError(
        'invalid_categories',
        'An agent listing needs at least one category before it can be published.',
      );
    }
    return tx.agentListing.update({
      where: { id },
      data: {
        status,
        ...(status === 'published' ? { publishedAt: listing.publishedAt ?? new Date() } : {}),
      },
      select: { id: true, directorySlug: true, status: true },
    });
  });
}

export async function deleteDirectoryAgentListing(id: string) {
  try {
    return await db.$transaction(async (tx) => {
      const listing = await tx.agentListing.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!listing) throw new AdminAgentMarketError('not_found', 'Agent listing not found.');
      const installs = await tx.agentInstall.count({
        where: { release: { listingId: id } },
      });
      if (installs > 0) {
        throw new AdminAgentMarketError(
          'installed',
          `Refused: ${installs} agent install(s) reference this listing.`,
          installs,
        );
      }
      await tx.agentListing.delete({ where: { id } });
    });
  } catch (error) {
    if (error instanceof AdminAgentMarketError) throw error;
    if (isPrismaForeignKeyError(error)) {
      const installs = await db.agentInstall.count({
        where: { release: { listingId: id } },
      });
      throw new AdminAgentMarketError(
        'installed',
        `Refused: ${installs} agent install(s) reference this listing.`,
        installs,
      );
    }
    throw error;
  }
}

export function readAgentReleaseManifest(raw: unknown, checksum?: string): AgentReleaseManifestV1 {
  return parseAgentReleaseManifest(raw, checksum);
}
