import 'server-only';
import type { ModelMessage } from 'ai';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;');
}

export function assembleSystemPrompt(systemPrompt: string | null | undefined, skills: SkillForPrompt[]): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  if (skills.length > 0) {
    const skillSections = skills.map((s) => {
      const label = skillLabel({ skillId: s.skillId, skill: s.skill, name: s.name ?? null, slug: s.slug ?? null, source: null });
      const description = s.skill?.description ?? s.description ?? '';
      return [
        ' <skill>',
        `  <name>${xmlText(label.name)}</name>`,
        `  <description>${xmlText(description)}</description>`,
        `  <location>toolplane://skills/${encodeURIComponent(label.slug)}/SKILL.md</location>`,
        '</skill>',
      ].join('\n');
    });
    sections.push([
      'The following skills provide specialized instructions for specific tasks.',
      'Use the skill_read_file tool to load a skill\'s SKILL.md when the task matches its description. Pass the skill name and path "SKILL.md".',
      'Locations are ToolPlane skill identifiers, not host filesystem paths.',
      'When a skill file references a relative path, resolve it relative to its skill directory and pass that relative path to skill_read_file or skill_run_script.',
      '',
      '<available_skills>',
      ...skillSections,
      '</available_skills>',
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
