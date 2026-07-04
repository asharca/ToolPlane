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
    include: {
      servers: {
        include: {
          deployment: {
            include: { server: { select: { name: true, slug: true } } },
          },
        },
      },
      skills: {
        include: {
          installedSkill: {
            include: { skill: { select: { name: true, slug: true } } },
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
    db.deployment.findMany({ where: { workspaceId }, select: { id: true } }),
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

// Workspace items not yet attached to the given toolkit, available to add.
export async function getToolkitComposables(
  workspaceId: string,
  toolkitId: string,
) {
  const [usedServers, usedSkills] = await Promise.all([
    db.toolkitServer.findMany({
      where: { toolkitId },
      select: { deploymentId: true },
    }),
    db.toolkitSkill.findMany({
      where: { toolkitId },
      select: { installedSkillId: true },
    }),
  ]);
  const usedDeploymentIds = usedServers.map((s) => s.deploymentId);
  const usedSkillIds = usedSkills.map((s) => s.installedSkillId);

  const [deployments, skills] = await Promise.all([
    db.deployment.findMany({
      where: { workspaceId, id: { notIn: usedDeploymentIds } },
      include: { server: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.installedSkill.findMany({
      where: { workspaceId, id: { notIn: usedSkillIds } },
      include: { skill: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { deployments, skills };
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
  const term = q.trim();
  const skip = (Math.max(1, page) - 1) * TOOLKIT_MARKET_PAGE_SIZE;
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

  const [total, rows] = await Promise.all([
    db.toolkit.count({ where }),
    db.toolkit.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: TOOLKIT_MARKET_PAGE_SIZE,
      include: {
        workspace: { select: { name: true, slug: true } },
        servers: {
          include: {
            deployment: {
              include: { server: { select: { name: true } } },
            },
          },
        },
        skills: {
          include: {
            installedSkill: {
              include: { skill: { select: { name: true } } },
            },
          },
        },
      },
    }),
  ]);

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
      serverCount: t.servers.length,
      skillCount: t.skills.length,
      customServerCount: t.servers.filter((s) => !s.deployment.serverId).length,
      toolCount: t.servers.length + t.skills.length,
      serverNames: serverNames.slice(0, 4),
      skillNames: skillNames.slice(0, 4),
      createdAt: t.createdAt,
    };
  });

  return { items, total, pageSize: TOOLKIT_MARKET_PAGE_SIZE };
}
