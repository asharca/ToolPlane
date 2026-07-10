import 'server-only';
import type { ModelMessage } from 'ai';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function assembleSystemPrompt(systemPrompt: string | null | undefined, skills: SkillForPrompt[]): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  if (skills.length > 0) {
    const skillSections = skills.map((s) => {
      const label = skillLabel({ skillId: s.skillId, skill: s.skill, name: s.name ?? null, slug: s.slug ?? null, source: null });
      const markdown = buildInstalledSkillMarkdown(s).trimEnd();
      return [
        `<skill name="${xmlAttr(label.name)}" slug="${xmlAttr(label.slug)}">`,
        '<skill_markdown>',
        markdown,
        '</skill_markdown>',
        '</skill>',
      ].join('\n');
    });
    sections.push([
      '# Attached Skill Runtime',
      '',
      'The skills below are active instructions for this agent. Apply them when relevant.',
      'If a skill references bundled files or scripts, use the skill tools to inspect or run those resources.',
      'Do not say an attached skill is unavailable merely because it is not an MCP tool.',
      'If a skill requires an external MCP server, CLI, package, or API that is not available, explain that missing dependency precisely and continue with the available skill instructions.',
      '',
      '<attached_skills>',
      ...skillSections,
      '</attached_skills>',
    ].join('\n'));
  }
  return sections.join('\n\n---\n\n');
}

export function prependSystemModelMessage(
  systemPrompt: string | null | undefined,
  messages: ModelMessage[],
): ModelMessage[] {
  const content = systemPrompt?.trim();
  if (!content) return messages;
  return [
    { role: 'system', content },
    ...messages.filter((message) => message.role !== 'system'),
  ];
}
