export type SkillForPrompt = {
  skillId: string | null;
  skill: { slug: string; name: string; description?: string | null; author?: string | null } | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  content?: string | null;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  effort?: string | null;
};

type AttachedSkill = { installedSkill: { id: string } & SkillForPrompt };

export type LoadedAgentTools = {
  servers: { deploymentId: string }[];
  skills: AttachedSkill[];
  toolkits: { toolkit: { servers: { deploymentId: string }[]; skills: AttachedSkill[] } }[];
};

export function resolveAgentTools(agent: LoadedAgentTools): { deploymentIds: string[]; skills: SkillForPrompt[] } {
  const depSet = new Set<string>();
  const skillMap = new Map<string, SkillForPrompt>();
  for (const s of agent.servers) depSet.add(s.deploymentId);
  for (const s of agent.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) depSet.add(s.deploymentId);
    for (const s of tk.toolkit.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  }
  const skills = [...skillMap.values()].filter((s) => s.agentInvocable !== false);
  return { deploymentIds: [...depSet], skills };
}
