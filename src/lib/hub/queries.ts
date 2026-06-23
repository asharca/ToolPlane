import { db } from '@/lib/db';

export function getHubServers(userId: string) {
  return db.server.findMany({
    where: { hubUsers: { some: { id: userId } } },
    orderBy: { stars: 'desc' },
  });
}

export async function isInHub(userId: string, serverId: string): Promise<boolean> {
  const count = await db.server.count({
    where: { id: serverId, hubUsers: { some: { id: userId } } },
  });
  return count > 0;
}
