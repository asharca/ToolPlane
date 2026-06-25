import { describe, it, expect } from 'vitest';
import { resolveAgentTools } from '@/lib/agents/resolve';

const skill = (id: string) => ({
  installedSkill: { id, skill: { slug: id, name: id, description: null, author: null } },
});

describe('resolveAgentTools', () => {
  it('merges direct servers/skills with toolkit-expanded ones and dedupes', () => {
    const { deploymentIds, skills } = resolveAgentTools({
      servers: [{ deploymentId: 'd1' }],
      skills: [skill('s1')],
      toolkits: [
        {
          toolkit: {
            servers: [{ deploymentId: 'd1' }, { deploymentId: 'd2' }],
            skills: [skill('s1'), skill('s2')],
          },
        },
      ],
    });
    expect(deploymentIds.sort()).toEqual(['d1', 'd2']);
    expect(skills.map((s) => s.slug).sort()).toEqual(['s1', 's2']);
  });

  it('returns empty arrays when nothing is attached', () => {
    expect(resolveAgentTools({ servers: [], skills: [], toolkits: [] })).toEqual({
      deploymentIds: [],
      skills: [],
    });
  });
});
