import { describe, it, expect } from 'vitest';
import { buildCustomSkillMarkdown, buildInstalledSkillMarkdown } from '@/lib/skills/artifact';

describe('buildCustomSkillMarkdown', () => {
  it('emits frontmatter from attributes + content body', () => {
    const md = buildCustomSkillMarkdown({ slug: 'my-skill', name: 'My Skill', description: 'does X', content: '# Body\n\nsteps', userInvocable: true, agentInvocable: false, effort: 'high' });
    expect(md).toContain('name: my-skill');
    expect(md).toContain('description: "does X"');
    expect(md).toContain('agent-invocable: false');
    expect(md).toContain('effort: high');
    expect(md).toContain('# Body');
  });
});

describe('buildInstalledSkillMarkdown', () => {
  it('uses catalog synthesis when skill present', () => {
    const md = buildInstalledSkillMarkdown({ skillId: 's1', skill: { slug: 'pdf', name: 'PDF', description: 'x', author: 'a' } });
    expect(md).toContain('name: pdf');
  });
  it('uses custom content when skill null', () => {
    const md = buildInstalledSkillMarkdown({ skillId: null, skill: null, slug: 'c', name: 'C', content: '# Hi', userInvocable: true, agentInvocable: true });
    expect(md).toContain('# Hi');
  });
});
