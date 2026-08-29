import 'server-only';

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import { parseAssistantReleaseManifest } from '@/lib/market/assistant-manifest';
import { parseSkillReleaseManifest } from '@/lib/market/skill-manifest';
import {
  parseResourceMarketManifest,
  projectPublicResourceMarketManifest,
} from '@/lib/market/resources';
import { scanMarketArtifact, scanSkillReleaseManifest } from '@/lib/market/secret-scan';

const LISTING_KINDS = new Set(['mcp', 'skill', 'toolkit', 'agent', 'assistant']);

export async function listMarketListings(input: {
  kind?: string;
  q?: string;
  tag?: string;
  category?: string;
  sort?: 'popular' | 'newest' | 'name';
  page?: number;
  pageSize?: number;
} = {}) {
  const kind = LISTING_KINDS.has(input.kind ?? '') ? input.kind : undefined;
  const term = input.q?.trim().slice(0, 200) ?? '';
  const tag = input.tag?.trim().toLocaleLowerCase().slice(0, 40) ?? '';
  const category = input.category?.trim().toLocaleLowerCase().slice(0, 120) ?? '';
  const sort = input.sort === 'newest' || input.sort === 'name' ? input.sort : 'popular';
  const page = Number.isSafeInteger(input.page) && (input.page ?? 0) > 0 ? input.page! : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 0) > 0
    ? Math.min(50, input.pageSize!)
    : 24;
  if (kind === 'agent') {
    const { listAgentMarketListings } = await import('@/lib/agents/market');
    const result = await listAgentMarketListings({
      q: term || tag,
      category,
      sort,
      page,
      pageSize,
    });
    return {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        kind: 'agent' as const,
        namespace: item.workspaceSlug ?? 'toolplane',
        slug: item.directorySlug,
        name: item.name,
        summary: item.summary,
        iconUrl: item.iconUrl,
        tags: item.tags,
        categories: item.categories,
        curated: item.curated,
        isFeatured: item.isFeatured,
        installCount: item.installCount,
        publishedAt: item.publishedAt,
        latestRelease: {
          id: item.latestReleaseId,
          version: item.latestVersion,
          releaseSummary: item.releaseSummary,
        },
      })),
    };
  }
  const baseWhere: Prisma.MarketListingWhereInput = {
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
    ...(kind ? { kind } : {}),
    ...(term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { summary: { contains: term, mode: 'insensitive' } },
        { namespace: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { tags: { has: term.toLocaleLowerCase() } },
        { categories: { some: { name: { contains: term, mode: 'insensitive' } } } },
      ],
    } : {}),
  };
  const where: Prisma.MarketListingWhereInput = {
    ...baseWhere,
    ...(tag ? { tags: { has: tag } } : {}),
    ...(category ? { categories: { some: { slug: category } } } : {}),
  };
  const orderBy: Prisma.MarketListingOrderByWithRelationInput[] = [
    { isFeatured: 'desc' },
    ...(sort === 'newest'
      ? [{ publishedAt: 'desc' as const }]
      : sort === 'name'
        ? [{ name: 'asc' as const }]
        : [{ installCount: 'desc' as const }, { publishedAt: 'desc' as const }]),
  ];
  const [total, availableTotal, items] = await Promise.all([
    db.marketListing.count({ where }),
    db.marketListing.count({ where: baseWhere }),
    db.marketListing.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy,
      select: {
        id: true,
        kind: true,
        namespace: true,
        slug: true,
        name: true,
        summary: true,
        iconUrl: true,
        tags: true,
        categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
        curated: true,
        isFeatured: true,
        installCount: true,
        publishedAt: true,
        latestRelease: { select: { id: true, version: true, releaseSummary: true } },
      },
    }),
  ]);
  return { items, total, availableTotal, page, pageSize };
}

export async function listMarketListingCategories(kind: 'skill' | 'assistant') {
  const listingWhere: Prisma.MarketListingWhereInput = {
    kind,
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
  };
  const rows = await db.category.findMany({
    where: { marketListings: { some: listingWhere } },
    orderBy: { name: 'asc' },
    select: {
      slug: true,
      name: true,
      _count: { select: { marketListings: { where: listingWhere } } },
    },
  });
  return rows
    .map((row) => ({ slug: row.slug, name: row.name, count: row._count.marketListings }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function getMarketListing(namespace: string, slug: string) {
  const listing = await db.marketListing.findFirst({
    where: {
      namespace,
      slug,
      status: 'published',
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: 'approved' } },
    },
    select: {
      id: true,
      kind: true,
      namespace: true,
      slug: true,
      publisherKind: true,
      name: true,
      summary: true,
      iconUrl: true,
      tags: true,
      categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
      metadata: true,
      status: true,
      curated: true,
      isFeatured: true,
      installCount: true,
      publishedAt: true,
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          manifest: true,
          releaseSummary: true,
          checksum: true,
          releaseNotes: true,
          publishedAt: true,
        },
      },
    },
  });
  if (!listing?.latestRelease) return null;
  const latestRelease = listing.latestRelease;
  let publicManifest: ReturnType<typeof parseResourceMarketManifest> | null = null;
  if (listing.kind === 'skill') {
    const manifest = parseSkillReleaseManifest(latestRelease.manifest, latestRelease.checksum);
    if (scanSkillReleaseManifest(manifest, latestRelease.releaseNotes).status === 'blocked') return null;
  } else if (listing.kind === 'assistant') {
    const manifest = parseAssistantReleaseManifest(latestRelease.manifest, latestRelease.checksum);
    if (scanMarketArtifact(manifest, latestRelease.releaseNotes).status === 'blocked') return null;
  } else if (listing.kind === 'mcp' || listing.kind === 'toolkit') {
    const manifest = parseResourceMarketManifest(latestRelease.manifest, latestRelease.checksum);
    if (scanMarketArtifact(manifest, latestRelease.releaseNotes).status === 'blocked') return null;
    publicManifest = projectPublicResourceMarketManifest(manifest);
  }
  const publicListing = { ...listing, latestRelease };
  if (!publicManifest) return publicListing;
  return {
    ...publicListing,
    latestRelease: {
      ...publicListing.latestRelease,
      manifest: publicManifest,
      checksum: marketReleaseChecksum(publicManifest),
    },
  };
}
