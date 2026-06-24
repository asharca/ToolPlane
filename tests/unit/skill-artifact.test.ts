import { describe, it, expect } from 'vitest';
import { buildSkillMarkdown } from '@/lib/skills/artifact';

describe('buildSkillMarkdown', () => {
  it('produces valid frontmatter with name and description', () => {
    const md = buildSkillMarkdown({
      slug: 'web-scraper',
      name: 'Web Scraper',
      description: 'Scrapes pages.',
      author: 'acme',
    });
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: web-scraper');
    expect(md).toContain('description: "Scrapes pages."');
    expect(md).toContain('# Web Scraper');
    expect(md).toContain('by acme');
  });

  it('falls back to a generated description when none is provided', () => {
    const md = buildSkillMarkdown({ slug: 's', name: 'Thing', description: null });
    expect(md).toContain('Thing agent skill installed from MCP Market.');
  });

  it('escapes quotes in the description so frontmatter stays valid', () => {
    const md = buildSkillMarkdown({
      slug: 's',
      name: 'Q',
      description: 'a "quoted" value',
    });
    expect(md).toContain('description: "a \\"quoted\\" value"');
  });
});
