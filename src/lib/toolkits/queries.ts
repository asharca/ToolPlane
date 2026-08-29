import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseToolkitMarketManifest } from '@/lib/market/resources';

export async function listToolkits(workspaceId: string) {
  const toolkits = await db.toolkit.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { servers: true, skills: true } },
    },
  });
  return toolkits.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    visibility: t.visibility,
    enabled: t.enabled,
    createdAt: t.createdAt,
    toolCount: t._count.servers + t._count.skills,
  }));
}

export async function getToolkitBySlug(workspaceId: string, slug: string) {
  return db.toolkit.findFirst({
    where: { workspaceId, slug },
    select: {
      id: true,
      name: true,
      slug: true,
      visibility: true,
      enabled: true,
      servers: {
        select: {
          id: true,
          deployment: {
            select: {
              id: true,
              status: true,
              serverId: true,
              name: true,
              source: true,
              sourceRef: true,
              server: { select: { name: true, slug: true } },
            },
          },
        },
      },
      skills: {
        select: {
          id: true,
          installedSkill: {
            select: {
              id: true,
              skillId: true,
              name: true,
              slug: true,
              source: true,
              skill: { select: { name: true, slug: true } },
            },
          },
        },
      },
    },
  });
}

// Every workspace has a default "My Toolkit" at slug "me". Create it lazily the
// first time it is opened, seeding it with everything currently in the
// workspace so the bundle is not empty for existing accounts.
export async function getOrCreateDefaultToolkit(workspaceId: string) {
  const existing = await db.toolkit.findFirst({
    where: { workspaceId, slug: 'me' },
  });
  if (existing) return existing;

  const [deployments, skills] = await Promise.all([
    db.deployment.findMany({
      where: {
        workspaceId,
        OR: [{ source: null }, { source: { notIn: ['sandbox'] } }],
      },
      select: { id: true },
    }),
    db.installedSkill.findMany({ where: { workspaceId }, select: { id: true } }),
  ]);

  return db.toolkit.create({
    data: {
      workspaceId,
      name: 'My Toolkit',
      slug: 'me',
      servers: { create: deployments.map((d) => ({ deploymentId: d.id })) },
      skills: { create: skills.map((s) => ({ installedSkillId: s.id })) },
    },
  });
}

export async function getToolkitMcpCandidates(workspaceId: string, toolkitId: string) {
  return db.deployment.findMany({
    where: {
      workspaceId,
      OR: [{ source: null }, { source: { notIn: ['sandbox'] } }],
      toolkitLinks: { none: { toolkitId } },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      serverId: true,
      name: true,
      source: true,
      sourceRef: true,
      server: { select: { name: true, slug: true, description: true } },
    },
  });
}

export async function getToolkitSkillCandidates(workspaceId: string, toolkitId: string) {
  return db.installedSkill.findMany({
    where: {
      workspaceId,
      toolkitLinks: { none: { toolkitId } },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      skillId: true,
      name: true,
      slug: true,
      description: true,
      source: true,
      sourceRef: true,
      userInvocable: true,
      agentInvocable: true,
      skill: { select: { name: true, slug: true, description: true } },
    },
  });
}

const TOOLKIT_MARKET_PAGE_SIZE = 20;

export type PublicToolkitBrowseItem = {
  id: string;
  name: string;
  slug: string;
  workspaceName: string;
  workspaceSlug: string;
  toolCount: number;
  serverCount: number;
  skillCount: number;
  customServerCount: number;
  serverNames: string[];
  skillNames: string[];
  categories: { slug: string; name: string }[];
  marketListing: { namespace: string; slug: string; releaseId: string } | null;
  createdAt: Date;
};

export type ToolkitBrowseFilters = {
  category?: string;
  sort?: 'newest' | 'name';
};

type ToolkitBrowseCandidate = PublicToolkitBrowseItem & { marketReleaseId?: string };

function marketCount(value: Prisma.JsonValue, key: 'mcpCount' | 'skillCount'): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const count = (value as Record<string, Prisma.JsonValue>)[key];
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export async function getBrowseToolkits(
  workspaceId: string,
  page: number,
  q = '',
  filters: ToolkitBrowseFilters = {},
) {
  const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const term = q.trim().slice(0, 160);
  const category = filters.category?.trim().toLocaleLowerCase().slice(0, 120) ?? '';
  const legacyWhere: Prisma.ToolkitWhereInput = {
    visibility: 'public',
    enabled: true,
    workspaceId: { not: workspaceId },
    sourceMarketListing: { is: null },
    AND: [
      ...(term
        ? [{
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            { slug: { contains: term, mode: 'insensitive' as const } },
            { workspace: { name: { contains: term, mode: 'insensitive' as const } } },
            { workspace: { slug: { contains: term, mode: 'insensitive' as const } } },
          ],
        }]
        : []),
    ],
  };
  const marketWhere: Prisma.MarketListingWhereInput = {
    kind: 'toolkit',
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
    sourceToolkit: { is: { visibility: 'public', enabled: true } },
    AND: [
      { OR: [{ publisherWorkspaceId: null }, { publisherWorkspaceId: { not: workspaceId } }] },
      ...(term ? [{
        OR: [
          { name: { contains: term, mode: 'insensitive' as const } },
          { slug: { contains: term, mode: 'insensitive' as const } },
          { namespace: { contains: term, mode: 'insensitive' as const } },
          { sourceToolkit: { is: { name: { contains: term, mode: 'insensitive' as const } } } },
          { sourceToolkit: { is: { slug: { contains: term, mode: 'insensitive' as const } } } },
        ],
      }] : []),
    ],
  };
  const [rows, marketRows] = await Promise.all([
    db.toolkit.findMany({
      where: legacyWhere,
      select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
      workspace: { select: { name: true, slug: true } },
      _count: { select: { servers: true, skills: true } },
      servers: {
        orderBy: { deploymentId: 'asc' },
        take: 4,
        select: {
          deployment: {
            select: {
              serverId: true,
              name: true,
              sourceRef: true,
              server: { select: { name: true } },
            },
          },
        },
      },
      skills: {
        orderBy: { installedSkillId: 'asc' },
        take: 4,
        select: {
          installedSkill: {
            select: {
              name: true,
              skill: { select: { name: true } },
            },
          },
        },
      },
      },
    }),
    db.marketListing.findMany({
      where: marketWhere,
      select: {
        id: true,
        namespace: true,
        slug: true,
        name: true,
        metadata: true,
        publishedAt: true,
        createdAt: true,
        categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
        sourceToolkit: { select: { id: true, slug: true } },
        publisherWorkspace: { select: { name: true, slug: true } },
        latestRelease: {
          select: { id: true, reviewStatus: true, publishedAt: true },
        },
      },
    }),
  ]);

  const customServerCounts = rows.length > 0
    ? await db.toolkitServer.groupBy({
        by: ['toolkitId'],
        where: {
          toolkitId: { in: rows.map((toolkit) => toolkit.id) },
          deployment: { serverId: null },
        },
        _count: { _all: true },
      })
    : [];
  const customServerCountByToolkit = new Map(
    customServerCounts.map((row) => [row.toolkitId, row._count._all]),
  );

  const legacyItems: PublicToolkitBrowseItem[] = rows.map((t) => {
    const serverNames = t.servers
      .map((s) => s.deployment.server?.name ?? s.deployment.name ?? s.deployment.sourceRef)
      .filter((name): name is string => Boolean(name));
    const skillNames = t.skills
      .map((s) => s.installedSkill.skill?.name ?? s.installedSkill.name)
      .filter((name): name is string => Boolean(name));
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      workspaceName: t.workspace.name,
      workspaceSlug: t.workspace.slug,
      serverCount: t._count.servers,
      skillCount: t._count.skills,
      customServerCount: customServerCountByToolkit.get(t.id) ?? 0,
      toolCount: t._count.servers + t._count.skills,
      serverNames,
      skillNames,
      categories: t.categories,
      marketListing: null,
      createdAt: t.createdAt,
    };
  });
  const marketItems = marketRows.flatMap((listing): ToolkitBrowseCandidate[] => {
    if (!listing.latestRelease || !listing.sourceToolkit) return [];
    const serverCount = marketCount(listing.metadata, 'mcpCount');
    const skillCount = marketCount(listing.metadata, 'skillCount');
    return [{
        id: listing.sourceToolkit.id,
        name: listing.name,
        slug: listing.sourceToolkit.slug,
        workspaceName: listing.publisherWorkspace?.name ?? listing.namespace,
        workspaceSlug: listing.publisherWorkspace?.slug ?? listing.namespace,
        serverCount,
        skillCount,
        customServerCount: 0,
        toolCount: serverCount + skillCount,
        serverNames: [],
        skillNames: [],
        categories: listing.categories,
        marketListing: {
          namespace: listing.namespace,
          slug: listing.slug,
          releaseId: listing.latestRelease.id,
        },
        marketReleaseId: listing.latestRelease.id,
        createdAt: listing.latestRelease.publishedAt ?? listing.publishedAt ?? listing.createdAt,
      }];
  });
  const allCandidates: ToolkitBrowseCandidate[] = [...legacyItems, ...marketItems];
  const available: ToolkitBrowseCandidate[] = allCandidates
    .sort((a, b) => filters.sort === 'name'
      ? a.name.localeCompare(b.name)
      : b.createdAt.getTime() - a.createdAt.getTime())
    .filter((item) => !category || item.categories.some(({ slug }) => slug === category));
  const categoryCounts = new Map<string, { name: string; count: number }>();
  for (const item of allCandidates) {
    for (const itemCategory of item.categories) {
      const current = categoryCounts.get(itemCategory.slug);
      categoryCounts.set(itemCategory.slug, {
        name: itemCategory.name,
        count: (current?.count ?? 0) + 1,
      });
    }
  }
  const categories = [...categoryCounts.entries()]
    .map(([slug, item]) => ({ slug, ...item }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const skip = (safePage - 1) * TOOLKIT_MARKET_PAGE_SIZE;
  const pageItems = available.slice(skip, skip + TOOLKIT_MARKET_PAGE_SIZE);
  const releaseIds = pageItems.flatMap(({ marketReleaseId }) => marketReleaseId ? [marketReleaseId] : []);
  const releases = releaseIds.length
    ? await db.marketRelease.findMany({
        where: { id: { in: releaseIds }, reviewStatus: 'approved' },
        select: { id: true, manifest: true, checksum: true },
      })
    : [];
  const manifests = new Map(releases.flatMap((release) => {
    try {
      return [[release.id, parseToolkitMarketManifest(release.manifest, release.checksum)] as const];
    } catch {
      return [];
    }
  }));
  return {
    items: pageItems.flatMap(({ marketReleaseId, ...item }) => {
      if (!marketReleaseId) return [item];
      const manifest = manifests.get(marketReleaseId);
      return manifest ? [{
        ...item,
        serverCount: manifest.mcps.length,
        skillCount: manifest.skills.length,
        toolCount: manifest.mcps.length + manifest.skills.length,
        serverNames: manifest.mcps.slice(0, 4).map(({ name }) => name),
        skillNames: manifest.skills.slice(0, 4).map(({ snapshot }) => snapshot.name),
      }] : [];
    }),
    total: available.length,
    availableTotal: legacyItems.length + marketItems.length,
    categories,
    pageSize: TOOLKIT_MARKET_PAGE_SIZE,
  };
}
