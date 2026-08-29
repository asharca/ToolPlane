import 'server-only';

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import {
  ASSISTANT_MARKET_MANIFEST_VERSION,
  assistantReleaseChecksum,
  buildAssistantReleaseManifest,
  parseAssistantReleaseManifest,
} from '@/lib/market/assistant-manifest';
import { scanMarketArtifact } from '@/lib/market/secret-scan';
import { hasVerifiedMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';

const PAGE_SIZE = 25;
export const ADMIN_MARKET_LISTING_STATUSES = ['draft', 'published', 'disabled'] as const;
export type AdminMarketListingStatus = (typeof ADMIN_MARKET_LISTING_STATUSES)[number];

export class AdminMarketCatalogError extends Error {
  constructor(readonly code:
    | 'not_found'
    | 'invalid_categories'
    | 'invalid_status'
    | 'release_required'
    | 'invalid_config'
    | 'invalid_manifest'
    | 'slug_conflict') {
    super(code);
    this.name = 'AdminMarketCatalogError';
  }
}

export type AdminAssistantTemplateInput = {
  slug: string;
  name: string;
  author: string;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  categoryIds: string[];
  status: AdminMarketListingStatus;
  isFeatured: boolean;
  systemPrompt: string | null;
  maxSteps: number;
  modelFormat: string | null;
  model: string | null;
  serverIds: string[];
};

function cleanTags(values: readonly string[]) {
  return [...new Set(values
    .map((value) => value.trim().toLocaleLowerCase().slice(0, 40))
    .filter(Boolean))]
    .slice(0, 20);
}

function isUniqueError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

export async function listAdminMarketListings({
  page = 1,
  q = '',
  kind,
}: {
  page?: number;
  q?: string;
  kind?: string;
} = {}) {
  const currentPage = normalizeAdminPage(page);
  const term = q.trim().slice(0, 200);
  const where: Prisma.MarketListingWhereInput = {
    ...(kind ? { kind } : {}),
    ...(term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { namespace: { contains: term, mode: 'insensitive' } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    db.marketListing.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        kind: true,
        publisherKind: true,
        namespace: true,
        slug: true,
        name: true,
        status: true,
        curated: true,
        isFeatured: true,
        latestVersion: true,
        installCount: true,
        categories: { select: { id: true }, orderBy: { name: 'asc' } },
        latestRelease: { select: { reviewStatus: true } },
        pendingRelease: { select: { version: true, reviewStatus: true } },
      },
    }),
    db.marketListing.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export async function listAdminPublicToolkits({
  page = 1,
  q = '',
}: {
  page?: number;
  q?: string;
} = {}) {
  const currentPage = normalizeAdminPage(page);
  const term = q.trim().slice(0, 200);
  const where: Prisma.ToolkitWhereInput = {
    visibility: 'public',
    ...(term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { workspace: { name: { contains: term, mode: 'insensitive' } } },
        { workspace: { slug: { contains: term, mode: 'insensitive' } } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    db.toolkit.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        enabled: true,
        categories: { select: { id: true }, orderBy: { name: 'asc' } },
        workspace: { select: { name: true, slug: true } },
        _count: { select: { servers: true, skills: true } },
      },
    }),
    db.toolkit.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

async function assertCategories(tx: Prisma.TransactionClient, categoryIds: string[]) {
  const uniqueIds = [...new Set(categoryIds)];
  if (uniqueIds.length !== categoryIds.length) throw new AdminMarketCatalogError('invalid_categories');
  const count = await tx.category.count({ where: { id: { in: uniqueIds } } });
  if (count !== uniqueIds.length) throw new AdminMarketCatalogError('invalid_categories');
  return uniqueIds;
}

export async function createAdminAssistantTemplate(
  input: AdminAssistantTemplateInput,
  reviewedById: string,
) {
  if (!ADMIN_MARKET_LISTING_STATUSES.includes(input.status)) {
    throw new AdminMarketCatalogError('invalid_status');
  }
  if (input.categoryIds.length === 0) throw new AdminMarketCatalogError('invalid_categories');
  if (input.maxSteps < 1 || input.maxSteps > 20 || Boolean(input.modelFormat) !== Boolean(input.model)) {
    throw new AdminMarketCatalogError('invalid_config');
  }
  try {
    return await db.$transaction(async (tx) => {
      const categoryIds = await assertCategories(tx, input.categoryIds);
      const serverIds = [...new Set(input.serverIds)];
      if (serverIds.length !== input.serverIds.length) {
        throw new AdminMarketCatalogError('invalid_config');
      }
      const servers = await tx.server.findMany({
        where: { id: { in: serverIds }, verifiedAt: { not: null } },
        orderBy: { slug: 'asc' },
        select: { id: true, slug: true, name: true },
      });
      if (servers.length !== serverIds.length) throw new AdminMarketCatalogError('invalid_config');

      const tags = cleanTags(input.tags);
      const manifest = buildAssistantReleaseManifest({
        name: input.name,
        systemPrompt: input.systemPrompt,
        maxSteps: input.maxSteps,
        model: input.model,
        modelProvider: input.modelFormat ? { format: input.modelFormat } : null,
        mcpGrants: servers.map((server) => ({
          deployment: {
            name: server.name,
            sourceRef: null,
            server: { slug: server.slug, name: server.name },
          },
        })),
      }, {
        slug: input.slug,
        name: input.name,
        summary: input.summary,
        iconUrl: input.iconUrl,
        tags,
        author: input.author,
      });
      const scanResult = scanMarketArtifact(manifest);
      if (scanResult.status === 'blocked') throw new AdminMarketCatalogError('invalid_manifest');
      const releaseSummary = {
        providerFormat: manifest.assistant.modelRequirement?.providerFormat ?? null,
        model: manifest.assistant.modelRequirement?.model ?? null,
        mcpCount: manifest.assistant.mcpRequirements.length,
        maxSteps: manifest.assistant.maxSteps,
      } satisfies Prisma.InputJsonObject;
      const publishedAt = new Date();
      const listing = await tx.marketListing.create({
        data: {
          kind: 'assistant',
          namespace: 'toolplane',
          slug: input.slug,
          publisherKind: 'platform',
          name: input.name,
          summary: input.summary,
          iconUrl: input.iconUrl,
          tags,
          metadata: {
            author: input.author,
            type: 'chat',
            ...releaseSummary,
          },
          status: input.status,
          curated: true,
          isFeatured: input.isFeatured,
          publishedAt: input.status === 'published' ? publishedAt : null,
          categories: { connect: categoryIds.map((id) => ({ id })) },
        },
        select: { id: true },
      });
      const release = await tx.marketRelease.create({
        data: {
          listingId: listing.id,
          version: 1,
          manifestVersion: ASSISTANT_MARKET_MANIFEST_VERSION,
          manifest: manifest as Prisma.InputJsonValue,
          releaseSummary,
          checksum: assistantReleaseChecksum(manifest),
          categoryIds,
          scanResult: scanResult as Prisma.InputJsonValue,
          reviewStatus: 'approved',
          reviewedById,
          reviewedAt: publishedAt,
          reviewNote: 'Created by an administrator.',
          publishedAt,
        },
        select: { id: true },
      });
      await tx.marketListing.update({
        where: { id: listing.id },
        data: { latestVersion: 1, latestReleaseId: release.id },
      });
      return { id: listing.id, releaseId: release.id };
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error instanceof AdminMarketCatalogError) throw error;
    if (isUniqueError(error)) throw new AdminMarketCatalogError('slug_conflict');
    throw error;
  }
}

export async function getAdminAssistantTemplate(id: string) {
  const listing = await db.marketListing.findFirst({
    where: { id, kind: 'assistant', publisherKind: 'platform' },
    include: {
      categories: { select: { id: true } },
      latestRelease: { select: { manifest: true, checksum: true } },
    },
  });
  if (!listing?.latestRelease) return null;
  const manifest = parseAssistantReleaseManifest(
    listing.latestRelease.manifest,
    listing.latestRelease.checksum,
  );
  const serverSlugs = manifest.assistant.mcpRequirements.map(({ catalogSlug }) => catalogSlug);
  const servers = serverSlugs.length
    ? await db.server.findMany({
        where: { slug: { in: serverSlugs }, verifiedAt: { not: null } },
        select: { id: true },
      })
    : [];
  return { listing, manifest, serverIds: servers.map(({ id: serverId }) => serverId) };
}

export async function updateAdminAssistantTemplate(
  id: string,
  input: AdminAssistantTemplateInput,
  reviewedById: string,
) {
  if (!ADMIN_MARKET_LISTING_STATUSES.includes(input.status)) {
    throw new AdminMarketCatalogError('invalid_status');
  }
  if (input.categoryIds.length === 0) throw new AdminMarketCatalogError('invalid_categories');
  if (input.maxSteps < 1 || input.maxSteps > 20 || Boolean(input.modelFormat) !== Boolean(input.model)) {
    throw new AdminMarketCatalogError('invalid_config');
  }
  return db.$transaction(async (tx) => {
    const listing = await tx.marketListing.findFirst({
      where: { id, kind: 'assistant', publisherKind: 'platform' },
      select: { id: true, slug: true, latestVersion: true, pendingReleaseId: true, publishedAt: true },
    });
    if (!listing) throw new AdminMarketCatalogError('not_found');
    if (listing.slug !== input.slug) throw new AdminMarketCatalogError('slug_conflict');
    const categoryIds = await assertCategories(tx, input.categoryIds);
    const serverIds = [...new Set(input.serverIds)];
    if (serverIds.length !== input.serverIds.length) throw new AdminMarketCatalogError('invalid_config');
    const servers = await tx.server.findMany({
      where: { id: { in: serverIds }, verifiedAt: { not: null } },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, name: true },
    });
    if (servers.length !== serverIds.length) throw new AdminMarketCatalogError('invalid_config');

    const tags = cleanTags(input.tags);
    const manifest = buildAssistantReleaseManifest({
      name: input.name,
      systemPrompt: input.systemPrompt,
      maxSteps: input.maxSteps,
      model: input.model,
      modelProvider: input.modelFormat ? { format: input.modelFormat } : null,
      mcpGrants: servers.map((server) => ({
        deployment: {
          name: server.name,
          sourceRef: null,
          server: { slug: server.slug, name: server.name },
        },
      })),
    }, {
      slug: listing.slug,
      name: input.name,
      summary: input.summary,
      iconUrl: input.iconUrl,
      tags,
      author: input.author,
    });
    const scanResult = scanMarketArtifact(manifest);
    if (scanResult.status === 'blocked') throw new AdminMarketCatalogError('invalid_manifest');
    if (listing.pendingReleaseId) {
      await tx.marketRelease.updateMany({
        where: { id: listing.pendingReleaseId, reviewStatus: 'pending' },
        data: { reviewStatus: 'rejected', reviewedAt: new Date(), reviewNote: 'Replaced by an administrator.' },
      });
    }
    const releaseSummary = {
      providerFormat: manifest.assistant.modelRequirement?.providerFormat ?? null,
      model: manifest.assistant.modelRequirement?.model ?? null,
      mcpCount: manifest.assistant.mcpRequirements.length,
      maxSteps: manifest.assistant.maxSteps,
    } satisfies Prisma.InputJsonObject;
    const publishedAt = new Date();
    const release = await tx.marketRelease.create({
      data: {
        listingId: listing.id,
        version: listing.latestVersion + 1,
        manifestVersion: ASSISTANT_MARKET_MANIFEST_VERSION,
        manifest: manifest as Prisma.InputJsonValue,
        releaseSummary,
        checksum: assistantReleaseChecksum(manifest),
        categoryIds,
        scanResult: scanResult as Prisma.InputJsonValue,
        reviewStatus: 'approved',
        reviewedById,
        reviewedAt: publishedAt,
        reviewNote: 'Updated by an administrator.',
        publishedAt,
      },
    });
    return tx.marketListing.update({
      where: { id: listing.id },
      data: {
        name: input.name,
        summary: input.summary,
        iconUrl: input.iconUrl,
        tags,
        metadata: { author: input.author, type: 'chat', ...releaseSummary },
        status: input.status,
        curated: true,
        isFeatured: input.isFeatured,
        latestVersion: release.version,
        latestReleaseId: release.id,
        pendingReleaseId: null,
        publishedAt: input.status === 'published' ? listing.publishedAt ?? publishedAt : listing.publishedAt,
        categories: { set: categoryIds.map((categoryId) => ({ id: categoryId })) },
      },
    });
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
}

export async function deleteAdminAssistantTemplate(id: string) {
  const deleted = await db.marketListing.deleteMany({
    where: { id, kind: 'assistant', publisherKind: 'platform' },
  });
  if (deleted.count !== 1) throw new AdminMarketCatalogError('not_found');
}

export async function updateAdminMarketListing(input: {
  id: string;
  status: AdminMarketListingStatus;
  curated: boolean;
  isFeatured: boolean;
  categoryIds: string[];
}) {
  if (!ADMIN_MARKET_LISTING_STATUSES.includes(input.status)) {
    throw new AdminMarketCatalogError('invalid_status');
  }
  return db.$transaction(async (tx) => {
    const listing = await tx.marketListing.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        kind: true,
        sourceServerId: true,
        sourceToolkitId: true,
        sourceServer: { select: { verifiedAt: true, verifiedTools: true, installCfg: true } },
        latestRelease: { select: { reviewStatus: true } },
      },
    });
    if (!listing) throw new AdminMarketCatalogError('not_found');
    if (input.status === 'published' && listing.latestRelease?.reviewStatus !== 'approved') {
      throw new AdminMarketCatalogError('release_required');
    }
    if (
      input.status === 'published'
      && listing.kind === 'mcp'
      && !hasVerifiedMcpToolCatalog(listing.sourceServer)
    ) {
      throw new AdminMarketCatalogError('invalid_config');
    }
    const categoryIds = await assertCategories(tx, input.categoryIds);
    const updated = await tx.marketListing.update({
      where: { id: listing.id },
      data: {
        status: input.status,
        curated: input.curated,
        isFeatured: input.isFeatured,
        categories: { set: categoryIds.map((id) => ({ id })) },
      },
    });
    if (listing.kind === 'mcp' && listing.sourceServerId) {
      await tx.server.update({
        where: { id: listing.sourceServerId },
        data: {
          categories: { set: categoryIds.map((id) => ({ id })) },
        },
      });
    }
    if (listing.kind === 'toolkit' && listing.sourceToolkitId) {
      await tx.toolkit.update({
        where: { id: listing.sourceToolkitId },
        data: {
          enabled: input.status === 'published',
          categories: { set: categoryIds.map((id) => ({ id })) },
        },
      });
    }
    return updated;
  });
}

export async function updateAdminPublicToolkit(input: {
  id: string;
  enabled: boolean;
  categoryIds: string[];
}) {
  return db.$transaction(async (tx) => {
    const toolkit = await tx.toolkit.findFirst({
      where: { id: input.id, visibility: 'public' },
      select: { id: true },
    });
    if (!toolkit) throw new AdminMarketCatalogError('not_found');
    const categoryIds = await assertCategories(tx, input.categoryIds);
    return tx.toolkit.update({
      where: { id: toolkit.id },
      data: {
        enabled: input.enabled,
        categories: { set: categoryIds.map((id) => ({ id })) },
      },
    });
  });
}
