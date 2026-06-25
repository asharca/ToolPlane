export type SkillMeta = {
  slug: string;
  name: string;
  description?: string | null;
  author?: string | null;
};

type AttachedSkill = { installedSkill: { id: string; skill: SkillMeta } };

export type LoadedAgentTools = {
  servers: { deploymentId: string }[];
  skills: AttachedSkill[];
  toolkits: {
    toolkit: {
      servers: { deploymentId: string }[];
      skills: AttachedSkill[];
    };
  }[];
};

export function resolveAgentTools(agent: LoadedAgentTools): {
  deploymentIds: string[];
  skills: SkillMeta[];
} {
  const depSet = new Set<string>();
  const skillMap = new Map<string, SkillMeta>();

  for (const s of agent.servers) depSet.add(s.deploymentId);
  for (const s of agent.skills) skillMap.set(s.installedSkill.id, s.installedSkill.skill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) depSet.add(s.deploymentId);
    for (const s of tk.toolkit.skills) skillMap.set(s.installedSkill.id, s.installedSkill.skill);
  }

  return { deploymentIds: [...depSet], skills: [...skillMap.values()] };
}
