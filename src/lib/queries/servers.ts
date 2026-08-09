import { db } from '@/lib/db';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';

export interface ListOpts { page: number; pageSize: number; }

export async function listServers(opts: ListOpts) {
  const page = Number.isSafeInteger(opts.page) && opts.page > 0
    ? opts.page
    : 1;
  const pageSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0
    ? Math.min(100, opts.pageSize)
    : 30;
  const total = await db.server.count();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) return { items: [], total, page, pageSize };

  const items = await db.server.findMany({
      orderBy: { stars: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        slug: true,
        name: true,
        author: true,
        description: true,
        iconUrl: true,
        stars: true,
        categories: { select: { name: true }, take: 1 },
      },
    });
  return { items, total, page, pageSize };
}

export async function getServer(slug: string) {
  const server = await db.server.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      author: true,
      description: true,
      iconUrl: true,
      stars: true,
      verifiedAt: true,
      installCfg: true,
      categories: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!server) return null;
  const { verifiedAt, installCfg, ...value } = server;
  return {
    ...value,
    deployable: Boolean(verifiedAt && parseServerRecipe(installCfg)),
  };
}

export async function getRelatedServers(
  excludeId: string,
  categoryIds: string[],
  take = 4,
) {
  const where =
    categoryIds.length > 0
      ? { id: { not: excludeId }, categories: { some: { id: { in: categoryIds } } } }
      : { id: { not: excludeId } };
  return db.server.findMany({
    where,
    orderBy: { stars: 'desc' },
    take,
    select: { slug: true, name: true, description: true, iconUrl: true },
  });
}
