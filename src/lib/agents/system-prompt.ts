import 'server-only';
import { buildSkillMarkdown } from '@/lib/skills/artifact';
import type { SkillMeta } from './resolve';

export function assembleSystemPrompt(
  systemPrompt: string | null | undefined,
  skills: SkillMeta[],
): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  for (const skill of skills) {
    sections.push(`# Skill: ${skill.name}\n\n${buildSkillMarkdown(skill)}`);
  }
  return sections.join('\n\n---\n\n');
}
