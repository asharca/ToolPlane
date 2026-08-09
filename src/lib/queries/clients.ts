import { db } from '@/lib/db';

export interface ClientListOptions { page: number; pageSize: number }

export async function listClients(opts: ClientListOptions) {
  const page = Number.isSafeInteger(opts.page) && opts.page > 0 ? opts.page : 1;
  const pageSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0
    ? Math.min(100, opts.pageSize)
    : 30;
  const total = await db.client.count();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) return { items: [], total, page, pageSize };

  const items = await db.client.findMany({
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

export async function getClient(slug: string) {
  return db.client.findUnique({
    where: { slug },
    select: {
      slug: true,
      name: true,
      author: true,
      description: true,
      iconUrl: true,
      stars: true,
      categories: { select: { id: true, slug: true, name: true } },
    },
  });
}
