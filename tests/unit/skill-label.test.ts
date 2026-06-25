import { describe, it, expect } from 'vitest';
import { skillLabel } from '@/lib/workspace/skill-label';

describe('skillLabel', () => {
  it('catalog', () => {
    expect(skillLabel({ skillId: 's1', skill: { name: 'PDF', slug: 'pdf' }, name: null, slug: null, source: null }))
      .toEqual({ name: 'PDF', slug: 'pdf', source: 'catalog' });
  });
  it('custom', () => {
    expect(skillLabel({ skillId: null, skill: null, name: 'My Skill', slug: 'my-skill', source: 'custom' }))
      .toEqual({ name: 'My Skill', slug: 'my-skill', source: 'custom' });
  });
});
