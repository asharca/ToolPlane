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
