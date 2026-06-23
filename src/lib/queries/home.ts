import { db } from '@/lib/db';

const SECTION_SIZE = 6;

export async function getHomeSections() {
  const [
    officialServers,
    featuredServers,
    topServers,
    latestServers,
    clients,
    topSkills,
  ] = await Promise.all([
    db.server.findMany({
      where: { isOfficial: true },
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
    }),
    db.server.findMany({
      where: { isFeatured: true },
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
    }),
    db.server.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
    }),
    db.server.findMany({
      orderBy: { createdAt: 'desc' },
      take: SECTION_SIZE,
    }),
    db.client.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
    }),
    db.skill.findMany({
      orderBy: { score: 'desc' },
      take: SECTION_SIZE,
    }),
  ]);

  return {
    officialServers,
    featuredServers,
    topServers,
    latestServers,
    clients,
    topSkills,
  };
}

export type HomeSections = Awaited<ReturnType<typeof getHomeSections>>;
