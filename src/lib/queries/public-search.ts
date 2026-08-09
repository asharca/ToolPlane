import { db } from '@/lib/db';
import { listPublicAgentDirectory } from '@/lib/queries/public-agents';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';

export async function searchPublicDirectory(query: string) {
  const q = query.trim().slice(0, 160);
  if (!q) return { servers: [], clients: [], skills: [], agents: [] };
  const where = {
    OR: [
      { name: { contains: q, mode: 'insensitive' as const } },
      { description: { contains: q, mode: 'insensitive' as const } },
    ],
  };
  const [servers, clients, skills, agents] = await Promise.all([
    db.server.findMany({
      where,
      take: 50,
      orderBy: { stars: 'desc' },
      select: {
        slug: true,
        name: true,
        author: true,
        description: true,
        iconUrl: true,
        stars: true,
        categories: { select: { name: true }, take: 1 },
      },
    }),
    db.client.findMany({
      where,
      take: 50,
      orderBy: { stars: 'desc' },
      select: {
        slug: true,
        name: true,
        author: true,
        description: true,
        iconUrl: true,
        stars: true,
        categories: { select: { name: true }, take: 1 },
      },
    }),
    db.skill.findMany({
      where,
      take: 50,
      orderBy: { score: 'desc' },
      select: {
        slug: true,
        name: true,
        author: true,
        description: true,
        iconUrl: true,
        score: true,
        categories: { select: { name: true }, take: 1 },
      },
    }),
    listPublicAgentDirectory({ query: q, take: 50 }),
  ]);
  return {
    servers,
    clients,
    skills: skills.map((skill) => ({
      ...skill,
      description: normalizedSkillDescription(skill.description),
    })),
    agents,
  };
}
