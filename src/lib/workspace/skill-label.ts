export type SkillLabelInput = {
  skillId: string | null;
  skill: { name: string; slug: string } | null;
  name: string | null;
  slug: string | null;
  source: string | null;
};

export type SkillLabel = { name: string; slug: string; source: string };

export function skillLabel(s: SkillLabelInput): SkillLabel {
  if (s.skillId && s.skill) return { name: s.skill.name, slug: s.skill.slug, source: 'catalog' };
  return { name: s.name ?? 'Untitled skill', slug: s.slug ?? 'skill', source: s.source ?? 'custom' };
}
