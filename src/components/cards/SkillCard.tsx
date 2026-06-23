import type { Skill } from '@prisma/client';
import { EntityCard, StarStat } from './EntityCard';

type SkillCardData = Pick<
  Skill,
  'slug' | 'name' | 'description' | 'author' | 'iconUrl' | 'score'
>;

export function SkillCard({ skill }: { skill: SkillCardData }) {
  return (
    <EntityCard
      href={`/tools/skills/${skill.slug}`}
      name={skill.name}
      description={skill.description}
      author={skill.author}
      iconUrl={skill.iconUrl}
      stat={<StarStat value={skill.score} />}
    />
  );
}
