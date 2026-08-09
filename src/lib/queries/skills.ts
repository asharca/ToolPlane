import { db } from '@/lib/db';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';

export interface SkillListOptions { page: number; pageSize: number }

const skillCardSelect = {
  slug: true,
  name: true,
  description: true,
  author: true,
  iconUrl: true,
  score: true,
  categories: { select: { name: true }, take: 1 },
} as const;

function normalizeSkillCards<Skill extends { description: string | null }>(skills: Skill[]) {
  return skills.map((skill) => ({
    ...skill,
    description: normalizedSkillDescription(skill.description),
  }));
}

export async function listSkills(opts: SkillListOptions) {
  const page = Number.isSafeInteger(opts.page) && opts.page > 0 ? opts.page : 1;
  const pageSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0
    ? Math.min(100, opts.pageSize)
    : 30;
  const total = await db.skill.count();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) return { items: [], total, page, pageSize };

  const skills = await db.skill.findMany({
    orderBy: { score: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: skillCardSelect,
  });
  return { items: normalizeSkillCards(skills), total, page, pageSize };
}

export async function listTopSkills(take = 100) {
  const skills = await db.skill.findMany({
    orderBy: { score: 'desc' },
    take: Math.min(100, Math.max(1, take)),
    select: skillCardSelect,
  });
  return normalizeSkillCards(skills);
}

export async function getSkill(slug: string) {
  const skill = await db.skill.findUnique({
    where: { slug },
    select: {
      slug: true,
      name: true,
      author: true,
      description: true,
      content: true,
      iconUrl: true,
      githubSource: true,
      score: true,
      curated: true,
      categories: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!skill) return null;
  const { content, curated, ...value } = skill;
  return {
    ...value,
    description: normalizedSkillDescription(value.description, content),
    installable: curated,
  };
}

export async function getRelatedSkills(categoryIds: string[], take = 3) {
  const where =
    categoryIds.length > 0
      ? { categories: { some: { id: { in: categoryIds } } } }
      : {};
  const skills = await db.skill.findMany({
    where,
    orderBy: { score: 'desc' },
    take,
    select: {
      slug: true,
      name: true,
      description: true,
      iconUrl: true,
    },
  });
  return normalizeSkillCards(skills);
}
