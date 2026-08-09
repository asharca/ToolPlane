import { db } from '@/lib/db';

export async function listPublicAgentDirectory(input: {
  query?: string;
  take?: number;
} = {}) {
  const query = input.query?.trim().slice(0, 160) ?? '';
  const normalizedTag = query.toLocaleLowerCase();
  const take = Math.min(50, Math.max(1, input.take ?? 24));

  return db.agentListing.findMany({
    where: {
      status: 'published',
      latestReleaseId: { not: null },
      publisherWorkspace: { is: {} },
      latestRelease: { is: { reviewStatus: 'approved' } },
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' as const } },
              { author: { contains: query, mode: 'insensitive' as const } },
              { summary: { contains: query, mode: 'insensitive' as const } },
              { tags: { has: normalizedTag } },
              {
                publisherWorkspace: {
                  is: { name: { contains: query, mode: 'insensitive' as const } },
                },
              },
            ],
          }
        : {}),
    },
    orderBy: [
      { isFeatured: 'desc' },
      { installCount: 'desc' },
      { publishedAt: 'desc' },
    ],
    take,
    select: {
      id: true,
      slug: true,
      name: true,
      author: true,
      summary: true,
      iconUrl: true,
      installCount: true,
      categories: { select: { name: true }, orderBy: { name: 'asc' } },
      publisherWorkspace: { select: { slug: true, name: true } },
    },
  });
}
