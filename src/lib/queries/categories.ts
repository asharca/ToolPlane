import { db } from '@/lib/db';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';

export async function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          servers: true,
          skills: true,
          agentListings: {
            where: {
              status: 'published',
              latestReleaseId: { not: null },
              publisherWorkspace: { is: {} },
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
    },
  });
}

export async function getCategory(slug: string) {
  const category = await db.category.findUnique({
    where: { slug },
    include: {
      _count: {
        select: {
          servers: true,
          skills: true,
          agentListings: {
            where: {
              status: 'published',
              latestReleaseId: { not: null },
              publisherWorkspace: { is: {} },
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
      servers: {
        orderBy: { stars: 'desc' },
        take: 60,
        select: {
          slug: true,
          name: true,
          author: true,
          description: true,
          iconUrl: true,
          stars: true,
          categories: { select: { name: true }, take: 1 },
        },
      },
      skills: {
        orderBy: { score: 'desc' },
        take: 60,
        select: {
          slug: true,
          name: true,
          author: true,
          description: true,
          iconUrl: true,
          score: true,
          categories: { select: { name: true }, take: 1 },
        },
      },
      agentListings: {
        where: {
          status: 'published',
          latestReleaseId: { not: null },
          publisherWorkspace: { is: {} },
          latestRelease: { is: { reviewStatus: 'approved' } },
        },
        orderBy: [
          { isFeatured: 'desc' },
          { installCount: 'desc' },
          { publishedAt: 'desc' },
        ],
        take: 60,
        select: {
          id: true,
          slug: true,
          name: true,
          summary: true,
          author: true,
          iconUrl: true,
          installCount: true,
          tags: true,
          categories: { select: { name: true } },
          publisherWorkspace: { select: { slug: true, name: true } },
        },
      },
    },
  });
  return category
    ? {
        ...category,
        skills: category.skills.map((skill) => ({
          ...skill,
          description: normalizedSkillDescription(skill.description),
        })),
      }
    : null;
}
