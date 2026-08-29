import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';
import { readMcpInspectorConnection } from '@/lib/workspace/inspector-connection';
import {
  hasMcpToolCatalog,
  hasVerifiedMcpToolCatalog,
  readMcpToolCatalog,
} from '@/lib/process/mcp-tool-catalog';

function slugifyEmail(email: string): string {
  const handle = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return handle || 'workspace';
}

export async function getOrCreateDefaultWorkspace(userId: string, email: string) {
  const existing = await db.workspace.findFirst({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  const base = slugifyEmail(email);
  let slug = base;
  for (let i = 1; await db.workspace.findUnique({ where: { slug } }); i += 1) {
    slug = `${base}-${i}`;
  }

  return db.workspace.create({
    data: {
      slug,
      name: `${base}'s workspace`,
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
}

export async function getWorkspaceForUser(slug: string, userId: string) {
  return db.workspace.findFirst({
    where: {
      slug,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
  });
}

export async function listWorkspacesForUser(userId: string) {
  return db.workspace.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true, name: true },
  });
}

export async function getDeployments(workspaceId: string) {
  return db.deployment.findMany({
    where: {
      workspaceId,
      OR: [{ source: null }, { source: { not: 'sandbox' } }],
    },
    orderBy: { createdAt: 'desc' },
    include: {
      server: { select: { slug: true, name: true, iconUrl: true } },
    },
  });
}

export async function getWorkspaceMembers(workspaceId: string) {
  return db.membership.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { email: true, name: true } } },
  });
}

export async function getInstalledSkills(workspaceId: string) {
  return db.installedSkill.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      skill: {
        select: { slug: true, name: true, iconUrl: true, description: true, content: true, files: true },
      },
    },
  });
}

const BROWSE_PAGE_SIZE = 25;
const BROWSE_SELECT = {
  id: true,
  slug: true,
  name: true,
  author: true,
  description: true,
  iconUrl: true,
  stars: true,
  isOfficial: true,
  isFeatured: true,
  createdAt: true,
  categories: { select: { name: true, slug: true } },
  marketListing: {
    select: {
      namespace: true,
      slug: true,
      status: true,
      latestRelease: { select: { id: true, reviewStatus: true } },
    },
  },
} as const;
const MARKET_MCP_SELECT = {
  id: true,
  namespace: true,
  slug: true,
  name: true,
  summary: true,
  iconUrl: true,
  metadata: true,
  curated: true,
  isFeatured: true,
  installCount: true,
  publishedAt: true,
  createdAt: true,
  categories: { select: { name: true, slug: true } },
  sourceServer: { select: { id: true } },
  latestRelease: { select: { id: true, reviewStatus: true, publishedAt: true } },
} as const;
const SKILL_BROWSE_SELECT = {
  id: true,
  slug: true,
  name: true,
  author: true,
  description: true,
  content: true,
  iconUrl: true,
  githubSource: true,
  curated: true,
  score: true,
  createdAt: true,
  categories: { select: { name: true, slug: true } },
} as const;

type RawBrowse = Prisma.ServerGetPayload<{ select: typeof BROWSE_SELECT }>;
type RawMarketMcp = Prisma.MarketListingGetPayload<{ select: typeof MARKET_MCP_SELECT }>;
export type BrowseServer = {
  id: string;
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  stars: number;
  isOfficial: boolean;
  isFeatured: boolean;
  createdAt: Date;
  categories: { name: string; slug: string }[];
  mcpKind: 'server' | 'connector';
  marketListing: { namespace: string; slug: string; releaseId: string } | null;
  deployable: true;
};
export type McpBrowseFilters = {
  category?: string;
  sort?: 'popular' | 'newest' | 'name';
  type?: 'server' | 'connector';
};
export type BrowseSkill = {
  id: string;
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  githubSource: string | null;
  curated: boolean;
  score: number;
  createdAt: Date;
  categories: { name: string; slug: string }[];
  installed: boolean;
  marketListing: {
    namespace: string;
    slug: string;
    releaseId: string;
    version: number;
    installCount: number;
  } | null;
};

export type SkillBrowseFilters = {
  workspaceId: string;
  source: 'all' | 'github' | 'other';
  installation: 'all' | 'available' | 'installed';
  category: string;
  sort: 'top' | 'newest' | 'name';
};

// The authenticated market is an operational catalog, not the public showcase:
// never return demo rows that cannot actually be deployed.
function toBrowse(rows: RawBrowse[], recipes: Map<string, Prisma.JsonValue | null>): BrowseServer[] {
  return rows.flatMap((server) => {
    const recipe = parseServerRecipe(recipes.get(server.id));
    return recipe
      ? [{
          id: server.id,
          slug: server.slug,
          name: server.name,
          author: server.author,
          description: server.description,
          iconUrl: server.iconUrl,
          stars: server.stars,
          isOfficial: server.isOfficial,
          isFeatured: server.isFeatured,
          createdAt: server.createdAt,
          categories: server.categories,
          mcpKind: recipe.source === 'remote' ? 'connector' as const : 'server' as const,
          marketListing: server.marketListing?.status === 'published'
            && server.marketListing.latestRelease?.reviewStatus === 'approved'
            ? {
                namespace: server.marketListing.namespace,
                slug: server.marketListing.slug,
                releaseId: server.marketListing.latestRelease.id,
              }
            : null,
          deployable: true as const,
        }]
      : [];
  });
}

function marketMetadata(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function toMarketBrowse(
  rows: RawMarketMcp[],
  recipes: Map<string, Prisma.JsonValue | null>,
): BrowseServer[] {
  return rows.flatMap((listing) => {
    if (!listing.sourceServer || !listing.latestRelease || listing.latestRelease.reviewStatus !== 'approved') return [];
    const recipe = parseServerRecipe(recipes.get(listing.sourceServer.id));
    if (!recipe) return [];
    const metadata = marketMetadata(listing.metadata);
    return [{
      id: listing.sourceServer.id,
      slug: listing.slug,
      name: listing.name,
      author: typeof metadata.author === 'string' ? metadata.author : listing.namespace,
      description: listing.summary,
      iconUrl: listing.iconUrl,
      stars: listing.installCount,
      isOfficial: listing.curated,
      isFeatured: listing.isFeatured,
      createdAt: listing.latestRelease.publishedAt ?? listing.publishedAt ?? listing.createdAt,
      categories: listing.categories,
      mcpKind: recipe.source === 'remote' ? 'connector' : 'server',
      marketListing: {
        namespace: listing.namespace,
        slug: listing.slug,
        releaseId: listing.latestRelease.id,
      },
      deployable: true as const,
    }];
  });
}

function sortBrowseServers(rows: BrowseServer[], sort: 'popular' | 'newest' | 'name') {
  return rows.sort((a, b) => sort === 'newest'
    ? b.createdAt.getTime() - a.createdAt.getTime() || a.name.localeCompare(b.name)
    : sort === 'name'
      ? a.name.localeCompare(b.name)
      : b.stars - a.stars || a.name.localeCompare(b.name));
}

export async function getBrowseServers(page: number, q = '', filters: McpBrowseFilters = {}) {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const category = filters.category?.trim() ?? '';
  const type = filters.type === 'connector' || filters.type === 'server' ? filters.type : undefined;
  const sort = filters.sort === 'newest' || filters.sort === 'name' ? filters.sort : 'popular';
  const where: Prisma.ServerWhereInput = {
    verifiedAt: { not: null },
    marketListing: { is: null },
    AND: [
      ...(term
        ? [{
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
          { author: { contains: term, mode: 'insensitive' as const } },
          { slug: { contains: term, mode: 'insensitive' as const } },
          { categories: { some: { name: { contains: term, mode: 'insensitive' as const } } } },
          ],
        }]
        : []),
    ],
  };
  const marketWhere: Prisma.MarketListingWhereInput = {
    kind: 'mcp',
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
    sourceServer: { is: { verifiedAt: { not: null } } },
    ...(term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { summary: { contains: term, mode: 'insensitive' } },
        { namespace: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { categories: { some: { name: { contains: term, mode: 'insensitive' } } } },
        { sourceServer: { is: { name: { contains: term, mode: 'insensitive' } } } },
        { sourceServer: { is: { slug: { contains: term, mode: 'insensitive' } } } },
      ],
    } : {}),
  };

  // Recipe validity is stronger than a JSON-not-null database predicate, so
  // validate before paginating to keep totals and pages accurate.
  const [rows, marketRows] = await Promise.all([
    db.server.findMany({ where, select: BROWSE_SELECT }),
    db.marketListing.findMany({ where: marketWhere, select: MARKET_MCP_SELECT }),
  ]);
  // Project out the potentially multi-megabyte tool snapshot before validating recipes.
  const serverIds = [...new Set([
    ...rows.map(({ id }) => id),
    ...marketRows.flatMap(({ sourceServer }) => sourceServer ? [sourceServer.id] : []),
  ])];
  const recipeRows = serverIds.length
    ? await db.$queryRaw<Array<{ id: string; installCfg: Prisma.JsonValue | null }>>(Prisma.sql`
        SELECT "id", "installCfg" - 'toolCatalog' AS "installCfg"
        FROM "Server"
        WHERE "id" IN (${Prisma.join(serverIds)})
          AND jsonb_typeof("installCfg" -> 'toolCatalog') = 'array'
          AND "verifiedTools" = jsonb_array_length("installCfg" -> 'toolCatalog')
          AND "verifiedTools" BETWEEN 0 AND 1000
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof("installCfg" -> 'toolCatalog') = 'array'
                  THEN "installCfg" -> 'toolCatalog'
                ELSE '[]'::jsonb
              END
            ) AS tool
            WHERE jsonb_typeof(tool) IS DISTINCT FROM 'object'
              OR jsonb_typeof(tool -> 'name') IS DISTINCT FROM 'string'
              OR btrim(tool ->> 'name') = ''
              OR jsonb_typeof(tool -> 'inputSchema') IS DISTINCT FROM 'object'
          )
      `)
    : [];
  const recipes = new Map(recipeRows.map((row) => [row.id, row.installCfg]));
  const catalogServerIds = new Set(recipeRows.map(({ id }) => id));
  const valid = sortBrowseServers([
    ...toBrowse(rows, recipes),
    ...toMarketBrowse(
      marketRows.filter(({ sourceServer }) => sourceServer && catalogServerIds.has(sourceServer.id)),
      recipes,
    ),
  ], sort);
  const typed = type ? valid.filter((server) => server.mcpKind === type) : valid;
  const categoryCounts = new Map<string, { name: string; count: number }>();
  for (const server of typed) {
    for (const item of server.categories) {
      const current = categoryCounts.get(item.slug);
      categoryCounts.set(item.slug, { name: item.name, count: (current?.count ?? 0) + 1 });
    }
  }
  const categories = [...categoryCounts.entries()]
    .map(([slug, item]) => ({ slug, ...item }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const filtered = category
    ? typed.filter((server) => server.categories.some((item) => item.slug === category))
    : typed;
  const featured = term || category || sort !== 'popular'
    ? []
    : filtered.filter((server) => server.isFeatured).slice(0, 12);
  return {
    featured,
    all: filtered.slice(skip, skip + BROWSE_PAGE_SIZE),
    total: filtered.length,
    availableTotal: typed.length,
    pageSize: BROWSE_PAGE_SIZE,
    categories,
  };
}

export async function getMarketServer(slug: string, workspaceId: string) {
  const server = await db.server.findFirst({
    where: {
      slug,
      verifiedAt: { not: null },
      marketListing: { is: null },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      author: true,
      description: true,
      iconUrl: true,
      stars: true,
      isOfficial: true,
      readme: true,
      verifiedAt: true,
      verifiedTools: true,
      installCfg: true,
      categories: { select: { name: true, slug: true } },
      deployments: {
        where: { workspaceId },
        select: { id: true, status: true, installCfg: true },
        take: 1,
      },
    },
  });
  if (!server) return null;
  if (!hasVerifiedMcpToolCatalog(server)) return null;
  const recipe = parseServerRecipe(server.installCfg);
  if (!recipe) return null;
  const readmeUrls = server.readme?.match(/https?:\/\/[^\s<>()\[\]"']+/g)
    ?.flatMap((value) => {
      const cleaned = value.replace(/[.,;!?]+$/, '');
      try {
        const url = new URL(cleaned);
        return !url.username && !url.password ? [cleaned] : [];
      } catch {
        return [];
      }
    }) ?? [];
  const sourceUrl = recipe.sourceUrl
    ?? readmeUrls.find((value) => {
      try {
        return new URL(value).hostname.toLowerCase() === 'github.com';
      } catch {
        return false;
      }
    })
    ?? readmeUrls[0]
    ?? (recipe.source === 'github'
      ? recipe.ref
      : recipe.source === 'npm'
        ? `https://www.npmjs.com/package/${recipe.ref.split('/').map(encodeURIComponent).join('/')}`
        : recipe.source === 'pypi'
          ? `https://pypi.org/project/${encodeURIComponent(recipe.ref)}/`
          : null);
  const deployment = server.deployments[0];
  const mcpKind = recipe.source === 'remote' ? 'connector' as const : 'server' as const;
  const connection = mcpKind === 'connector'
    ? readMcpInspectorConnection(deployment?.installCfg)
    : null;
  const sandbox = connection ? await db.sandbox.findFirst({
    where: { id: connection.sandboxId, workspaceId },
    select: { id: true, deployment: { select: { id: true, status: true } } },
  }) : null;
  const toolCatalogKnown = mcpKind === 'server'
    || Boolean(connection && sandbox && hasMcpToolCatalog(deployment?.installCfg));
  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    author: server.author,
    description: server.description,
    iconUrl: server.iconUrl,
    stars: server.stars,
    isOfficial: server.isOfficial,
    readme: server.readme,
    verifiedTools: server.verifiedTools,
    sourceUrl,
    mcpKind,
    connector: recipe.source === 'remote'
      ? {
          endpointHost: new URL(recipe.ref).hostname,
          transport: recipe.transport ?? 'streamable-http',
          authType: recipe.authType ?? 'none',
        }
      : null,
    categories: server.categories,
    tools: toolCatalogKnown
      ? readMcpToolCatalog(mcpKind === 'server' ? server.installCfg : deployment?.installCfg)
      : [],
    toolCatalogKnown,
    inspectorSandbox: connection && sandbox ? {
      id: sandbox.id,
      deploymentId: sandbox.deployment.id,
      status: sandbox.deployment.status,
      connectedAt: connection.connectedAt,
    } : null,
    recipe: {
      source: recipe.source,
      ref: recipe.ref,
      requiredEnv: recipe.env,
      network: recipe.network ?? 'isolated',
      transport: recipe.transport,
      authType: recipe.authType,
    },
    deploymentId: deployment?.id ?? null,
    deploymentStatus: deployment?.status ?? null,
  };
}

type RawBrowseSkill = Omit<BrowseSkill, 'installed' | 'marketListing'> & {
  content: string | null;
  installs: { id: string }[];
};

function toBrowseSkills(rows: RawBrowseSkill[]): BrowseSkill[] {
  return rows.map(({ installs, content, ...skill }) => ({
    ...skill,
    description: normalizedSkillDescription(skill.description, content),
    installed: installs.length > 0,
    marketListing: null,
  }));
}

const PUBLIC_DIRECTORY_SKILL_WHERE = {
  curated: true,
  NOT: {
    marketListing: {
      is: {
        kind: 'skill',
        status: 'published',
        latestReleaseId: { not: null },
        latestRelease: { is: { reviewStatus: 'approved' } },
      },
    },
  },
} satisfies Prisma.SkillWhereInput;

export async function getSkillBrowseCategories(includeMarket = false) {
  const marketWhere = {
    kind: 'skill',
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
  } satisfies Prisma.MarketListingWhereInput;
  const rows = await db.category.findMany({
    where: includeMarket
      ? { OR: [{ skills: { some: PUBLIC_DIRECTORY_SKILL_WHERE } }, { marketListings: { some: marketWhere } }] }
      : { skills: { some: PUBLIC_DIRECTORY_SKILL_WHERE } },
    orderBy: { name: 'asc' },
    select: {
      name: true,
      slug: true,
      _count: {
        select: {
          skills: { where: PUBLIC_DIRECTORY_SKILL_WHERE },
          marketListings: { where: marketWhere },
        },
      },
    },
  });
  return rows.map(({ _count, ...row }) => ({
    ...row,
    _count: { skills: _count.skills + (includeMarket ? _count.marketListings : 0) },
  }));
}

export async function getBrowseSkills(page: number, q: string, filters: SkillBrowseFilters) {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const whereParts: Prisma.SkillWhereInput[] = [PUBLIC_DIRECTORY_SKILL_WHERE];
  if (term) {
    whereParts.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { author: { contains: term, mode: 'insensitive' as const } },
        { slug: { contains: term, mode: 'insensitive' as const } },
      ],
    });
  }
  if (filters.source === 'github') whereParts.push({ githubSource: { not: null } });
  if (filters.source === 'other') whereParts.push({ githubSource: null });
  if (filters.installation === 'installed') {
    whereParts.push({ installs: { some: { workspaceId: filters.workspaceId } } });
  }
  if (filters.installation === 'available') {
    whereParts.push({ installs: { none: { workspaceId: filters.workspaceId } } });
  }
  const availableWhere: Prisma.SkillWhereInput = { AND: [...whereParts] };
  if (filters.category === 'uncategorized') whereParts.push({ categories: { none: {} } });
  else if (filters.category !== 'all') {
    whereParts.push({ categories: { some: { slug: filters.category } } });
  }

  const where: Prisma.SkillWhereInput = whereParts.length ? { AND: whereParts } : {};
  const orderBy: Prisma.SkillOrderByWithRelationInput[] = filters.sort === 'newest'
    ? [{ createdAt: 'desc' }]
    : filters.sort === 'name'
      ? [{ name: 'asc' }]
      : [{ score: 'desc' }, { name: 'asc' }];
  const select = {
    ...SKILL_BROWSE_SELECT,
    installs: {
      where: { workspaceId: filters.workspaceId },
      select: { id: true },
      take: 1,
    },
  } as const;
  const isFiltered = Boolean(
    term ||
      filters.source !== 'all' ||
      filters.installation !== 'all' ||
      filters.category !== 'all' ||
      filters.sort !== 'top',
  );
  const includeMarket = filters.source === 'all' && filters.installation === 'all';
  const marketBaseWhere: Prisma.MarketListingWhereInput = {
    kind: 'skill',
    status: 'published',
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: 'approved' } },
    ...(term ? {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { summary: { contains: term, mode: 'insensitive' } },
        { namespace: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
      ],
    } : {}),
  };
  const marketWhere: Prisma.MarketListingWhereInput = {
    ...marketBaseWhere,
    ...(filters.category === 'uncategorized'
      ? { categories: { none: {} } }
      : filters.category !== 'all'
        ? { categories: { some: { slug: filters.category } } }
        : {}),
  };
  const candidateCount = skip + BROWSE_PAGE_SIZE;

  const [featuredRows, catalogTotal, catalogAvailableTotal, allRows, marketTotal, marketAvailableTotal, marketRows] = await Promise.all([
    isFiltered
      ? Promise.resolve([] as RawBrowseSkill[])
      : db.skill.findMany({
          where: PUBLIC_DIRECTORY_SKILL_WHERE,
          orderBy: { score: 'desc' },
          take: 12,
          select,
        }),
    db.skill.count({ where }),
    db.skill.count({ where: availableWhere }),
    db.skill.findMany({
      where,
      orderBy,
      take: candidateCount,
      select,
    }),
    includeMarket ? db.marketListing.count({ where: marketWhere }) : Promise.resolve(0),
    includeMarket ? db.marketListing.count({ where: marketBaseWhere }) : Promise.resolve(0),
    includeMarket
      ? db.marketListing.findMany({
          where: marketWhere,
          orderBy: filters.sort === 'newest'
            ? [{ publishedAt: 'desc' }, { name: 'asc' }]
            : filters.sort === 'name'
              ? [{ name: 'asc' }]
              : [{ installCount: 'desc' }, { name: 'asc' }],
          take: candidateCount,
          select: {
            id: true,
            namespace: true,
            slug: true,
            name: true,
            summary: true,
            iconUrl: true,
            curated: true,
            installCount: true,
            publishedAt: true,
            createdAt: true,
            categories: { select: { name: true, slug: true } },
            latestRelease: { select: { id: true, version: true } },
            installs: {
              where: { targetWorkspaceId: filters.workspaceId },
              select: { id: true },
              take: 1,
            },
          },
        })
      : Promise.resolve([]),
  ]);
  const marketSkills: BrowseSkill[] = marketRows.flatMap((listing) => listing.latestRelease ? [{
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    author: listing.namespace,
    description: listing.summary,
    iconUrl: listing.iconUrl,
    githubSource: null,
    curated: listing.curated,
    score: listing.installCount,
    createdAt: listing.publishedAt ?? listing.createdAt,
    categories: listing.categories,
    installed: listing.installs.length > 0,
    marketListing: {
      namespace: listing.namespace,
      slug: listing.slug,
      releaseId: listing.latestRelease.id,
      version: listing.latestRelease.version,
      installCount: listing.installCount,
    },
  }] : []);
  const combined = [...toBrowseSkills(allRows), ...marketSkills]
    .sort((a, b) => filters.sort === 'newest'
      ? b.createdAt.getTime() - a.createdAt.getTime() || a.name.localeCompare(b.name)
      : filters.sort === 'name'
        ? a.name.localeCompare(b.name)
        : b.score - a.score || a.name.localeCompare(b.name));

  return {
    featured: toBrowseSkills(featuredRows),
    all: combined.slice(skip, skip + BROWSE_PAGE_SIZE),
    total: catalogTotal + marketTotal,
    availableTotal: catalogAvailableTotal + marketAvailableTotal,
    pageSize: BROWSE_PAGE_SIZE,
  };
}

export async function getMarketSkill(slug: string, workspaceId: string) {
  const skill = await db.skill.findFirst({
    where: { slug, curated: true },
    select: {
      id: true,
      slug: true,
      name: true,
      author: true,
      description: true,
      iconUrl: true,
      githubSource: true,
      content: true,
      files: true,
      score: true,
      categories: { select: { name: true, slug: true } },
      installs: {
        where: { workspaceId },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!skill) return null;
  const { installs, ...marketSkill } = skill;
  return {
    ...marketSkill,
    description: normalizedSkillDescription(marketSkill.description, marketSkill.content),
    installId: installs[0]?.id ?? null,
  };
}
