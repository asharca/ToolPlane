import { db } from '@/lib/db';

export async function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { servers: true } } },
  });
}

export async function getCategory(slug: string) {
  return db.category.findUnique({
    where: { slug },
    include: { servers: { orderBy: { stars: 'desc' }, take: 60 } },
  });
}
