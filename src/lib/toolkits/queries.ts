import "server-only";
import { db } from "@/lib/db";

export async function listToolkits(workspaceId: string) {
  const toolkits = await db.toolkit.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
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
