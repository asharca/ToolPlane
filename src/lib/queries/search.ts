import { db } from '@/lib/db';

export async function searchAll(query: string) {
  const q = query.trim();
  if (!q) return { servers: [], clients: [], skills: [] };
  const where = {
    OR: [
      { name: { contains: q, mode: 'insensitive' as const } },
      { description: { contains: q, mode: 'insensitive' as const } },
    ],
  };
  const [servers, clients, skills] = await Promise.all([
    db.server.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.client.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.skill.findMany({ where, take: 50, orderBy: { score: 'desc' } }),
  ]);
  return { servers, clients, skills };
}
