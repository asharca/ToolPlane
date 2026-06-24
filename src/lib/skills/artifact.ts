import 'server-only';

type SkillMeta = {
  slug: string;
  name: string;
  description?: string | null;
  author?: string | null;
};

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

// Produce a valid Agent Skill file (SKILL.md): YAML frontmatter with `name`
// and `description`, followed by markdown instructions. This is a real,
// usable artifact that can be dropped into an agent's skills directory.
export function buildSkillMarkdown(skill: SkillMeta): string {
  const description =
    skill.description?.trim() ||
    `${skill.name} agent skill installed from MCP Market.`;
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

Installed from MCP Market. Replace these starter instructions with the
concrete procedure your agent should follow for ${skill.name}.
`;
}
