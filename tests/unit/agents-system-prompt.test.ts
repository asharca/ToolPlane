import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import type { SkillForPrompt } from '@/lib/agents/resolve';

const catalogSkill = (slug: string, name: string, description: string): SkillForPrompt => ({
  skillId: slug,
  skill: { slug, name, description, author: null },
  name: null,
  slug: null,
  description: null,
  content: null,
  userInvocable: true,
  agentInvocable: true,
  effort: null,
});

describe('assembleSystemPrompt', () => {
  it('combines the base prompt with each skill SKILL.md', () => {
    const out = assembleSystemPrompt('You are helpful.', [
      catalogSkill('web-scraper', 'Web Scraper', 'Scrapes pages.'),
    ]);
    expect(out).toContain('You are helpful.');
    expect(out).toContain('# Skill: Web Scraper');
    expect(out).toContain('name: web-scraper'); // from buildSkillMarkdown frontmatter
  });

  it('omits the base section when no system prompt is set', () => {
    const out = assembleSystemPrompt(null, [
      catalogSkill('s', 'Thing', ''),
    ]);
    expect(out.startsWith('# Skill: Thing')).toBe(true);
  });

  it('returns an empty string when there is nothing to assemble', () => {
    expect(assembleSystemPrompt('   ', [])).toBe('');
  });

  it('includes custom skill content directly', () => {
    const custom: SkillForPrompt = {
      skillId: null,
      skill: null,
      name: 'My Custom Skill',
      slug: 'my-custom-skill',
      description: 'Does something custom.',
      content: '# My Custom Skill\n\nDo the custom thing.',
      userInvocable: true,
      agentInvocable: true,
      effort: 'default',
    };
    const out = assembleSystemPrompt(null, [custom]);
    expect(out).toContain('# Skill: My Custom Skill');
    expect(out).toContain('Do the custom thing.');
  });
});
