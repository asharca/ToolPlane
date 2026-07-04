import 'server-only';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

export function assembleSystemPrompt(systemPrompt: string | null | undefined, skills: SkillForPrompt[]): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  if (skills.length > 0) {
    sections.push([
      '# Attached Skill Runtime',
      '',
      'The skills below are active instructions for this agent. Apply them when relevant.',
      'If a skill references bundled files or scripts, use the skill tools to inspect or run those resources.',
      'Do not say an attached skill is unavailable merely because it is not an MCP tool.',
      'If a skill requires an external MCP server, CLI, package, or API that is not available, explain that missing dependency precisely and continue with the available skill instructions.',
    ].join('\n'));
  }
  for (const s of skills) {
    const label = skillLabel({ skillId: s.skillId, skill: s.skill, name: s.name ?? null, slug: s.slug ?? null, source: null });
    sections.push(`# Skill: ${label.name}\n\n${buildInstalledSkillMarkdown(s)}`);
  }
  return sections.join('\n\n---\n\n');
}
