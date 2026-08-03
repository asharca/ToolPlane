import { db } from '@/lib/db';
import { listAgentMarketListings } from '@/lib/agents/market';

// Internal catalog search helper. Public `(site)` routes must not import this;
// the authenticated workspace market owns all live catalog discovery.
export async function searchAll(query: string) {
  const q = query.trim();
  if (!q) return { servers: [], clients: [], skills: [], agents: [] };
  const where = {
    OR: [
      { name: { contains: q, mode: 'insensitive' as const } },
      { description: { contains: q, mode: 'insensitive' as const } },
    ],
  };
  const [servers, clients, skills, agentResult] = await Promise.all([
    db.server.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.client.findMany({ where, take: 50, orderBy: { stars: 'desc' } }),
    db.skill.findMany({ where, take: 50, orderBy: { score: 'desc' } }),
    listAgentMarketListings({ q, pageSize: 50, sort: 'popular' }),
  ]);
  return { servers, clients, skills, agents: agentResult.items };
}
