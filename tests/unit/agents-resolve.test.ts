import { describe, it, expect } from 'vitest';
import { resolveAgentTools } from '@/lib/agents/resolve';

const skill = (id: string) => ({
  installedSkill: {
    id,
    skillId: id,
    skill: { slug: id, name: id, description: null, author: null },
    name: null,
    slug: null,
    description: null,
    content: null,
    userInvocable: true,
    agentInvocable: true,
    effort: null,
  },
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
    expect(skills.map((s) => s.skill?.slug).sort()).toEqual(['s1', 's2']);
  });

  it('returns empty arrays when nothing is attached', () => {
    expect(resolveAgentTools({ servers: [], skills: [], toolkits: [] })).toEqual({
      deploymentIds: [],
      sandboxDeploymentIds: [],
      skills: [],
      subAgents: [],
    });
  });

  it('adds sandbox deployments to the agent tool list and tracks them separately', () => {
    const { deploymentIds, sandboxDeploymentIds } = resolveAgentTools({
      servers: [{ deploymentId: 'mcp1' }],
      skills: [],
      toolkits: [],
      sandboxes: [{ sandbox: { deploymentId: 'sandbox1' } }],
    });
    expect(deploymentIds.sort()).toEqual(['mcp1', 'sandbox1']);
    expect(sandboxDeploymentIds).toEqual(['sandbox1']);
  });

  it('filters out skills where agentInvocable is false', () => {
    const s1 = skill('s1');
    const s2 = { installedSkill: { ...skill('s2').installedSkill, agentInvocable: false } };
    const { skills } = resolveAgentTools({ servers: [], skills: [s1, s2], toolkits: [] });
    expect(skills).toHaveLength(1);
    expect(skills[0].skill?.slug).toBe('s1');
  });

  it('does not treat legacy draft status as a visibility gate', () => {
    const draftSkill = {
      installedSkill: {
        id: 'custom-draft',
        skillId: null,
        skill: null,
        name: 'Draft Skill',
        slug: 'draft-skill',
        description: null,
        content: null,
        userInvocable: true,
        agentInvocable: true,
        effort: null,
        status: 'draft',
      },
    };
    const publishedSkill = {
      installedSkill: {
        id: 'custom-published',
        skillId: null,
        skill: null,
        name: 'Published Skill',
        slug: 'published-skill',
        description: null,
        content: null,
        userInvocable: true,
        agentInvocable: true,
        effort: null,
        status: 'published',
      },
    };
    const { skills } = resolveAgentTools({ servers: [], skills: [draftSkill, publishedSkill], toolkits: [] });
    expect(skills.map((s) => s.slug).sort()).toEqual(['draft-skill', 'published-skill']);
  });
});
