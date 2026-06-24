import { db } from '@/lib/db';

const SECTION_SIZE = 6;
const withCategory = { categories: { select: { name: true }, take: 1 } };

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
      include: withCategory,
    }),
    db.server.findMany({
      where: { isFeatured: true },
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
      include: withCategory,
    }),
    db.server.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
      include: withCategory,
    }),
    db.server.findMany({
      orderBy: { createdAt: 'desc' },
      take: SECTION_SIZE,
      include: withCategory,
    }),
    db.client.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
      include: withCategory,
    }),
    db.skill.findMany({
      orderBy: { score: 'desc' },
      take: SECTION_SIZE,
      include: withCategory,
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
