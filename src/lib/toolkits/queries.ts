import 'server-only';
import { db } from '@/lib/db';

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
  createdAt: Date;
};

export async function getBrowseToolkits(workspaceId: string, page: number, q = '') {
  const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const term = q.trim().slice(0, 160);
  const where = {
    visibility: 'public',
    enabled: true,
    workspaceId: { not: workspaceId },
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            { slug: { contains: term, mode: 'insensitive' as const } },
            { workspace: { name: { contains: term, mode: 'insensitive' as const } } },
            { workspace: { slug: { contains: term, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const total = await db.toolkit.count({ where });
  const lastPage = Math.max(1, Math.ceil(total / TOOLKIT_MARKET_PAGE_SIZE));
  if (safePage > lastPage) {
    return { items: [], total, pageSize: TOOLKIT_MARKET_PAGE_SIZE };
  }

  const rows = await db.toolkit.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    skip: (safePage - 1) * TOOLKIT_MARKET_PAGE_SIZE,
    take: TOOLKIT_MARKET_PAGE_SIZE,
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
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
  });

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

  const items: PublicToolkitBrowseItem[] = rows.map((t) => {
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
      createdAt: t.createdAt,
    };
  });

  return { items, total, pageSize: TOOLKIT_MARKET_PAGE_SIZE };
}
