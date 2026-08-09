import { db } from '@/lib/db';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';

const SECTION_SIZE = 6;
const serverCardSelect = {
  slug: true,
  name: true,
  author: true,
  description: true,
  iconUrl: true,
  stars: true,
  isOfficial: true,
  isFeatured: true,
  createdAt: true,
  categories: { select: { name: true }, take: 1 },
} as const;

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
      select: serverCardSelect,
    }),
    db.server.findMany({
      where: { isFeatured: true },
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
      select: serverCardSelect,
    }),
    db.server.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
      select: serverCardSelect,
    }),
    db.server.findMany({
      orderBy: { createdAt: 'desc' },
      take: SECTION_SIZE,
      select: serverCardSelect,
    }),
    db.client.findMany({
      orderBy: { stars: 'desc' },
      take: SECTION_SIZE,
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
      orderBy: { score: 'desc' },
      take: SECTION_SIZE,
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
  ]);

  return {
    officialServers,
    featuredServers,
    topServers,
    latestServers,
    clients,
    topSkills: topSkills.map((skill) => ({
      ...skill,
      description: normalizedSkillDescription(skill.description),
    })),
  };
}

export type HomeSections = Awaited<ReturnType<typeof getHomeSections>>;
