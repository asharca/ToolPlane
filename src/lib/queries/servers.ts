import { db } from '@/lib/db';

export interface ListOpts { page: number; pageSize: number; }

export async function listServers(opts: ListOpts) {
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize));
  const [items, total] = await Promise.all([
    db.server.findMany({
      orderBy: { stars: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { categories: true },
    }),
    db.server.count(),
  ]);
  return { items, total, page, pageSize };
}

export async function getServer(slug: string) {
  return db.server.findUnique({ where: { slug }, include: { categories: true } });
}
