import 'server-only';
import { normalizeSkillFiles, type SkillBundleFile } from './bundle';

type SkillMeta = {
  slug: string;
  name: string;
  description?: string | null;
  author?: string | null;
  content?: string | null;
  files?: unknown;
};

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

// Produce a valid Agent Skill file (SKILL.md): YAML frontmatter with `name`
// and `description`, followed by markdown instructions. This is a real,
// usable artifact that can be dropped into an agent's skills directory.
export function buildSkillMarkdown(skill: SkillMeta): string {
  if (skill.content?.trim()) return skill.content;

  const description =
    skill.description?.trim() ||
    `${skill.name} agent skill installed from ToolPlane.`;
  const by = skill.author ? ` by ${skill.author}` : '';

  return `---
name: ${skill.slug}
description: ${yamlString(description)}
---

# ${skill.name}

${description}

## When to use this skill

Use this skill when a task calls for ${skill.name}${by}. The agent should
load these instructions and follow the steps below.

## Instructions

1. Confirm the user's goal and the inputs ${skill.name} needs.
2. Apply the ${skill.name} capability to produce the requested result.
3. Return the result to the user, citing any sources or assumptions.

## Notes

Installed from ToolPlane. Replace these starter instructions with the
concrete procedure your agent should follow for ${skill.name}.
`;
}

type CustomSkillData = {
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  content?: string | null;
  files?: unknown;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  effort?: string | null;
};

export function buildCustomSkillMarkdown(s: CustomSkillData): string {
  const slug = (s.slug || s.name || 'skill').trim();
  const description = (s.description || `${s.name ?? slug} agent skill.`).trim();
  const body = (s.content ?? '').trim() || `# ${s.name ?? slug}\n\n${description}`;
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(body)) return `${body}\n`;
  return [
    '---',
    `name: ${slug}`,
    `description: ${yamlString(description)}`,
    `user-invocable: ${s.userInvocable !== false}`,
    `agent-invocable: ${s.agentInvocable !== false}`,
    `effort: ${s.effort || 'default'}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function buildInstalledSkillMarkdown(installed: {
  skillId: string | null;
  skill: SkillMeta | null;
} & CustomSkillData): string {
  if (installed.skillId && installed.skill) return buildSkillMarkdown(installed.skill);
  return buildCustomSkillMarkdown(installed);
}

export function installedSkillExtraFiles(installed: {
  skillId: string | null;
  skill: SkillMeta | null;
} & CustomSkillData): SkillBundleFile[] {
  const files = installed.skillId && installed.skill ? installed.skill.files : installed.files;
  if (!Array.isArray(files)) return [];
  return normalizeSkillFiles(files as SkillBundleFile[]);
}
