import { db } from '@/lib/db';

export async function listSkills() {
  return db.skill.findMany({ orderBy: { score: 'desc' } });
}

export async function getSkill(slug: string) {
  return db.skill.findUnique({ where: { slug }, include: { categories: true } });
}

export async function getRelatedSkills(categoryIds: string[], take = 3) {
  const where =
    categoryIds.length > 0
      ? { categories: { some: { id: { in: categoryIds } } } }
      : {};
  return db.skill.findMany({
    where,
    orderBy: { score: 'desc' },
    take,
    select: { slug: true, name: true, description: true, iconUrl: true },
  });
}
