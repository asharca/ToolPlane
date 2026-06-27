import 'server-only';
import { db } from '@/lib/db';

export function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, _count: { select: { servers: true, skills: true, clients: true } } },
  });
}

export async function createCategory(slug: string, name: string) {
  return db.category.create({ data: { slug, name } });
}

export async function deleteCategory(id: string) {
  const c = await db.category.findUnique({
    where: { id },
    select: { _count: { select: { servers: true, skills: true, clients: true } } },
  });
  if (!c) throw new Error('Category not found.');
  if (c._count.servers + c._count.skills + c._count.clients > 0) throw new Error('Category is not empty.');
  await db.category.delete({ where: { id } });
}
