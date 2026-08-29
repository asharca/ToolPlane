import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { VISIBLE_AGENT_LISTING_ORIGIN } from '@/lib/agents/market-visibility';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';

const visibleMarketListing = {
  status: 'published',
  latestReleaseId: { not: null },
  latestRelease: { is: { reviewStatus: 'approved' } },
} satisfies Prisma.MarketListingWhereInput;

const visibleLegacyServer = {
  NOT: { marketListing: { is: visibleMarketListing } },
} satisfies Prisma.ServerWhereInput;

const visibleLegacySkill = {
  NOT: { marketListing: { is: visibleMarketListing } },
} satisfies Prisma.SkillWhereInput;

const visibleLegacyToolkit = {
  visibility: 'public',
  enabled: true,
  NOT: { sourceMarketListing: { is: visibleMarketListing } },
} satisfies Prisma.ToolkitWhereInput;

export async function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      marketListings: {
        where: {
          ...visibleMarketListing,
          OR: [
            { kind: 'mcp' },
            { kind: 'assistant' },
            { kind: 'toolkit' },
            { kind: 'skill' },
          ],
        },
        select: { kind: true },
      },
      _count: {
        select: {
          servers: { where: visibleLegacyServer },
          skills: { where: visibleLegacySkill },
          toolkits: { where: visibleLegacyToolkit },
          agentListings: {
            where: {
              status: 'published',
              latestReleaseId: { not: null },
              AND: [VISIBLE_AGENT_LISTING_ORIGIN],
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
    },
  }).then((categories) => categories.map(({ marketListings, _count, ...category }) => ({
    ...category,
    _count: {
      ..._count,
      servers: _count.servers + marketListings.filter(({ kind }) => kind === 'mcp').length,
      skills: _count.skills + marketListings.filter(({ kind }) => kind === 'skill').length,
      assistants: marketListings.filter(({ kind }) => kind === 'assistant').length,
      toolkits: _count.toolkits + marketListings.filter(({ kind }) => kind === 'toolkit').length,
    },
  })));
}

export async function getCategory(slug: string) {
  const category = await db.category.findUnique({
    where: { slug },
    include: {
      _count: {
        select: {
          servers: { where: visibleLegacyServer },
          skills: { where: visibleLegacySkill },
          agentListings: {
            where: {
              status: 'published',
              latestReleaseId: { not: null },
              AND: [VISIBLE_AGENT_LISTING_ORIGIN],
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
      servers: {
        where: visibleLegacyServer,
        orderBy: { stars: 'desc' },
        take: 60,
        select: {
          slug: true,
          name: true,
          author: true,
          description: true,
          iconUrl: true,
          stars: true,
          categories: { select: { name: true }, take: 1 },
        },
      },
      skills: {
        where: visibleLegacySkill,
        orderBy: { score: 'desc' },
        take: 60,
        select: {
          slug: true,
          name: true,
          author: true,
          description: true,
          iconUrl: true,
          score: true,
          categories: { select: { name: true }, take: 1 },
        },
      },
      agentListings: {
        where: {
          status: 'published',
          latestReleaseId: { not: null },
          AND: [VISIBLE_AGENT_LISTING_ORIGIN],
          latestRelease: { is: { reviewStatus: 'approved' } },
        },
        orderBy: [
          { isFeatured: 'desc' },
          { installCount: 'desc' },
          { publishedAt: 'desc' },
        ],
        take: 60,
        select: {
          id: true,
          slug: true,
          directorySlug: true,
          name: true,
          summary: true,
          author: true,
          iconUrl: true,
          installCount: true,
          tags: true,
          categories: { select: { name: true } },
          publisherWorkspace: { select: { slug: true, name: true } },
        },
      },
    },
  });
  if (!category) return null;

  const marketWhere = { ...visibleMarketListing, categories: { some: { id: category.id } } };
  const toolkitWhere = { ...visibleLegacyToolkit, categories: { some: { id: category.id } } };
  const listingSelect = {
    id: true,
    kind: true,
    namespace: true,
    slug: true,
    name: true,
    summary: true,
    iconUrl: true,
    installCount: true,
  } as const;
  const [communityMcps, communitySkills, assistants, marketToolkits, legacyToolkits, communityMcpCount, communitySkillCount, assistantCount, marketToolkitCount, legacyToolkitCount] = await Promise.all([
    db.marketListing.findMany({
      where: { ...marketWhere, kind: 'mcp' },
      orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
      take: 60,
      select: listingSelect,
    }),
    db.marketListing.findMany({
      where: { ...marketWhere, kind: 'skill' },
      orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
      take: 60,
      select: listingSelect,
    }),
    db.marketListing.findMany({
      where: { ...marketWhere, kind: 'assistant' },
      orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
      take: 60,
      select: listingSelect,
    }),
    db.marketListing.findMany({
      where: { ...marketWhere, kind: 'toolkit' },
      orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
      take: 60,
      select: listingSelect,
    }),
    db.toolkit.findMany({
      where: toolkitWhere,
      orderBy: { updatedAt: 'desc' },
      take: 60,
      select: {
        id: true,
        slug: true,
        name: true,
        workspace: { select: { slug: true, name: true } },
        _count: { select: { servers: true, skills: true } },
      },
    }),
    db.marketListing.count({ where: { ...marketWhere, kind: 'mcp' } }),
    db.marketListing.count({ where: { ...marketWhere, kind: 'skill' } }),
    db.marketListing.count({ where: { ...marketWhere, kind: 'assistant' } }),
    db.marketListing.count({ where: { ...marketWhere, kind: 'toolkit' } }),
    db.toolkit.count({ where: toolkitWhere }),
  ]);
  return {
    ...category,
    _count: {
      ...category._count,
      servers: category._count.servers + communityMcpCount,
      skills: category._count.skills + communitySkillCount,
      assistants: assistantCount,
      toolkits: marketToolkitCount + legacyToolkitCount,
    },
    skills: category.skills.map((skill) => ({
      ...skill,
      description: normalizedSkillDescription(skill.description),
    })),
    communityMcps,
    communitySkills,
    assistants,
    toolkits: [
      ...marketToolkits.map((toolkit) => ({
        ...toolkit,
        href: `/market/${encodeURIComponent(toolkit.namespace)}/${encodeURIComponent(toolkit.slug)}`,
        publisher: toolkit.namespace,
        resourceSummary: toolkit.summary,
      })),
      ...legacyToolkits.map((toolkit) => ({
        ...toolkit,
        href: `/app?market=toolkits&q=${encodeURIComponent(toolkit.name)}`,
        publisher: toolkit.workspace.name,
        resourceSummary: null,
      })),
    ],
  };
}
