import { db } from '@/lib/db';

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
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
    },
  });
}

export async function getCategory(slug: string) {
  return db.category.findUnique({
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
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
      servers: { orderBy: { stars: 'desc' }, take: 60 },
      skills: { orderBy: { score: 'desc' }, take: 60 },
      agentListings: {
        where: {
          status: 'published',
          latestReleaseId: { not: null },
          latestRelease: { is: { reviewStatus: 'approved' } },
        },
        orderBy: [
          { isFeatured: 'desc' },
          { installCount: 'desc' },
          { publishedAt: 'desc' },
        ],
        take: 60,
        select: {
          directorySlug: true,
          name: true,
          summary: true,
          author: true,
          iconUrl: true,
          installCount: true,
          tags: true,
          categories: { select: { name: true } },
        },
      },
    },
  });
}
