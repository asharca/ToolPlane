import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';

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
  installCfg: true,
  categories: { select: { name: true, slug: true } },
} as const;
const SKILL_BROWSE_SELECT = {
  id: true,
  slug: true,
  name: true,
  author: true,
  description: true,
  iconUrl: true,
  githubSource: true,
  curated: true,
  categories: { select: { name: true, slug: true } },
} as const;

type RawBrowse = Prisma.ServerGetPayload<{ select: typeof BROWSE_SELECT }>;
export type BrowseServer = {
  id: string;
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  stars: number;
  isOfficial: boolean;
  categories: { name: string; slug: string }[];
  deployable: true;
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
  categories: { name: string; slug: string }[];
  installed: boolean;
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
function toBrowse(rows: RawBrowse[]): BrowseServer[] {
  return rows.flatMap((server) => (
    parseServerRecipe(server.installCfg)
      ? [{
          id: server.id,
          slug: server.slug,
          name: server.name,
          author: server.author,
          description: server.description,
          iconUrl: server.iconUrl,
          stars: server.stars,
          isOfficial: server.isOfficial,
          categories: server.categories,
          deployable: true as const,
        }]
      : []
  ));
}

export async function getBrowseServers(page: number, q = '') {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const where: Prisma.ServerWhereInput = {
    verifiedAt: { not: null },
    ...(term
      ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
          { author: { contains: term, mode: 'insensitive' as const } },
          { slug: { contains: term, mode: 'insensitive' as const } },
          { categories: { some: { name: { contains: term, mode: 'insensitive' as const } } } },
        ],
      }
      : {}),
  };

  // Recipe validity is stronger than a JSON-not-null database predicate, so
  // validate before paginating to keep totals and pages accurate.
  const rows = await db.server.findMany({
    where,
    orderBy: [{ stars: 'desc' }, { name: 'asc' }],
    select: BROWSE_SELECT,
  });
  const valid = toBrowse(rows);
  const featured = term
    ? []
    : toBrowse(rows.filter((server) => server.isFeatured)).slice(0, 12);
  return {
    featured,
    all: valid.slice(skip, skip + BROWSE_PAGE_SIZE),
    total: valid.length,
    pageSize: BROWSE_PAGE_SIZE,
  };
}

export async function getMarketServer(slug: string, workspaceId: string) {
  const server = await db.server.findFirst({
    where: { slug, verifiedAt: { not: null } },
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
      verifiedTools: true,
      installCfg: true,
      categories: { select: { name: true, slug: true } },
      deployments: {
        where: { workspaceId },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!server) return null;
  const recipe = parseServerRecipe(server.installCfg);
  if (!recipe) return null;
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
    categories: server.categories,
    recipe: {
      source: recipe.source,
      ref: recipe.ref,
      requiredEnv: recipe.env,
      network: recipe.network ?? 'isolated',
    },
    deploymentId: server.deployments[0]?.id ?? null,
  };
}

type RawBrowseSkill = Omit<BrowseSkill, 'installed'> & { installs: { id: string }[] };

function toBrowseSkills(rows: RawBrowseSkill[]): BrowseSkill[] {
  return rows.map(({ installs, ...skill }) => ({ ...skill, installed: installs.length > 0 }));
}

export async function getSkillBrowseCategories() {
  return db.category.findMany({
    where: { skills: { some: { curated: true } } },
    orderBy: { name: 'asc' },
    select: {
      name: true,
      slug: true,
      _count: { select: { skills: { where: { curated: true } } } },
    },
  });
}

export async function getBrowseSkills(page: number, q: string, filters: SkillBrowseFilters) {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const whereParts: Prisma.SkillWhereInput[] = [{ curated: true }];
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

  const [featuredRows, total, allRows] = await Promise.all([
    isFiltered
      ? Promise.resolve([] as RawBrowseSkill[])
      : db.skill.findMany({
          where: { curated: true },
          orderBy: { score: 'desc' },
          take: 12,
          select,
        }),
    db.skill.count({ where }),
    db.skill.findMany({
      where,
      orderBy,
      skip,
      take: BROWSE_PAGE_SIZE,
      select,
    }),
  ]);

  return {
    featured: toBrowseSkills(featuredRows),
    all: toBrowseSkills(allRows),
    total,
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
  return { ...marketSkill, installId: installs[0]?.id ?? null };
}
