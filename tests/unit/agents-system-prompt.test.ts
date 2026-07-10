import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, prependSystemModelMessage } from '@/lib/agents/system-prompt';
import type { ModelMessage } from 'ai';
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
    expect(out).toContain('<skill name="Web Scraper" slug="web-scraper">');
    expect(out).toContain('<skill_markdown>\n---\nname: web-scraper');
    expect(out).toContain('name: web-scraper'); // from buildSkillMarkdown frontmatter
  });

  it('omits the base section when no system prompt is set', () => {
    const out = assembleSystemPrompt(null, [
      catalogSkill('s', 'Thing', ''),
    ]);
    expect(out).toContain('# Attached Skill Runtime');
    expect(out).toContain('<attached_skills>');
    expect(out).toContain('<skill name="Thing" slug="s">');
    expect(out).not.toContain('You are helpful.');
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
    expect(out).toContain('<skill name="My Custom Skill" slug="my-custom-skill">');
    expect(out).toContain('Do the custom thing.');
  });

  it('keeps skill markdown frontmatter inside an explicit skill boundary', () => {
    const out = assembleSystemPrompt(null, [
      catalogSkill('quoted', 'Quoted "Skill"', 'Escapes labels.'),
    ]);

    expect(out).toContain('<skill name="Quoted &quot;Skill&quot;" slug="quoted">');
    expect(out).toContain('<skill_markdown>\n---\nname: quoted');
    expect(out).not.toContain('# Skill: Quoted "Skill"\n\n---');
  });
});

describe('prependSystemModelMessage', () => {
  it('puts the assembled system prompt in the first model message', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];

    expect(prependSystemModelMessage('Use tools carefully.', messages)).toEqual([
      { role: 'system', content: 'Use tools carefully.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('does not add an empty system message', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];

    expect(prependSystemModelMessage('   ', messages)).toBe(messages);
  });
});
