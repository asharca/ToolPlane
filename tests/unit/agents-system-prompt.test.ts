import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';

describe('assembleSystemPrompt', () => {
  it('combines the base prompt with each skill SKILL.md', () => {
    const out = assembleSystemPrompt('You are helpful.', [
      { slug: 'web-scraper', name: 'Web Scraper', description: 'Scrapes pages.' },
    ]);
    expect(out).toContain('You are helpful.');
    expect(out).toContain('# Skill: Web Scraper');
    expect(out).toContain('name: web-scraper'); // from buildSkillMarkdown frontmatter
  });

  it('omits the base section when no system prompt is set', () => {
    const out = assembleSystemPrompt(null, [
      { slug: 's', name: 'Thing', description: null },
    ]);
    expect(out.startsWith('# Skill: Thing')).toBe(true);
  });

  it('returns an empty string when there is nothing to assemble', () => {
    expect(assembleSystemPrompt('   ', [])).toBe('');
  });
});
