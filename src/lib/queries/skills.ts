import { db } from '@/lib/db';

export async function listSkills() {
  return db.skill.findMany({ orderBy: { score: 'desc' } });
}

export async function getSkill(slug: string) {
  return db.skill.findUnique({ where: { slug }, include: { categories: true } });
}
