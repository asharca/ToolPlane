import 'server-only';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

export function assembleSystemPrompt(systemPrompt: string | null | undefined, skills: SkillForPrompt[]): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  for (const s of skills) {
    const label = skillLabel({ skillId: s.skillId, skill: s.skill, name: s.name ?? null, slug: s.slug ?? null, source: null });
    sections.push(`# Skill: ${label.name}\n\n${buildInstalledSkillMarkdown(s)}`);
  }
  return sections.join('\n\n---\n\n');
}
