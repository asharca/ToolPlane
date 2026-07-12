import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

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
const BROWSE_SELECT = { id: true, name: true, description: true, iconUrl: true, verifiedAt: true } as const;
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

type RawBrowse = { id: string; name: string; description: string | null; iconUrl: string | null; verifiedAt: Date | null };
export type BrowseServer = { id: string; name: string; description: string | null; iconUrl: string | null; deployable: boolean };
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

// A catalog server is deployable only once an admin has wired up a recipe and
// it has passed validation (verifiedAt set).
function toBrowse(rows: RawBrowse[]): BrowseServer[] {
  return rows.map(({ verifiedAt, ...r }) => ({ ...r, deployable: verifiedAt !== null }));
}

export async function getBrowseServers(page: number, q = '') {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const where = term
    ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [featured, total, all] = await Promise.all([
    // Skip the Featured rail while searching — the result list is what matters.
    term
      ? Promise.resolve([] as RawBrowse[])
      : db.server.findMany({
          where: { isFeatured: true },
          orderBy: { stars: 'desc' },
          take: 12,
          select: BROWSE_SELECT,
        }),
    db.server.count({ where }),
    db.server.findMany({
      where,
      orderBy: { stars: 'desc' },
      skip,
      take: BROWSE_PAGE_SIZE,
      select: BROWSE_SELECT,
    }),
  ]);
  return { featured: toBrowse(featured), all: toBrowse(all), total, pageSize: BROWSE_PAGE_SIZE };
}

type RawBrowseSkill = Omit<BrowseSkill, 'installed'> & { installs: { id: string }[] };

function toBrowseSkills(rows: RawBrowseSkill[]): BrowseSkill[] {
  return rows.map(({ installs, ...skill }) => ({ ...skill, installed: installs.length > 0 }));
}

export async function getSkillBrowseCategories() {
  return db.category.findMany({
    where: { skills: { some: {} } },
    orderBy: { name: 'asc' },
    select: { name: true, slug: true, _count: { select: { skills: true } } },
  });
}

export async function getBrowseSkills(page: number, q: string, filters: SkillBrowseFilters) {
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const whereParts: Prisma.SkillWhereInput[] = [];
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
