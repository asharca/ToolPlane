import type { Skill } from '@prisma/client';
import { EntityCard, ScoreStat } from './EntityCard';

type SkillCardData = Pick<
  Skill,
  'slug' | 'name' | 'description' | 'author' | 'iconUrl' | 'score'
> & { categories?: { name: string }[] };

export function SkillCard({ skill }: { skill: SkillCardData }) {
  return (
    <EntityCard
      href={`/tools/skills/${skill.slug}`}
      name={skill.name}
      description={skill.description}
      author={skill.author}
      iconUrl={skill.iconUrl}
      category={skill.categories?.[0]?.name ?? null}
      stat={<ScoreStat value={skill.score} />}
    />
  );
}
