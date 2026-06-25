import { describe, it, expect } from 'vitest';
import { parseCreateSkill, isGithubUrl, githubRawSkillUrl } from '@/lib/skills/custom-skill';

describe('parseCreateSkill', () => {
  it('derives a slug from the name', () => {
    expect(parseCreateSkill({ name: 'My Cool Skill', description: 'x' })).toEqual({ name: 'My Cool Skill', description: 'x', slug: 'my-cool-skill' });
  });
  it('rejects empty name', () => {
    expect(() => parseCreateSkill({ name: '  ', description: '' })).toThrow();
  });
});

describe('github helpers', () => {
  it('accepts github urls only', () => {
    expect(isGithubUrl('https://github.com/org/repo')).toBe(true);
    expect(isGithubUrl('https://evil.com/org/repo')).toBe(false);
  });
  it('maps repo url to a raw SKILL.md url', () => {
    expect(githubRawSkillUrl('https://github.com/org/repo/tree/main')).toBe('https://raw.githubusercontent.com/org/repo/HEAD/SKILL.md');
  });
});
