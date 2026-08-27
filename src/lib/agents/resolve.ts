export type SkillForPrompt = {
  skillId: string | null;
  skill: {
    slug: string;
    name: string;
    description?: string | null;
    author?: string | null;
    content?: string | null;
    files?: unknown;
  } | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  content?: string | null;
  files?: unknown;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  status?: string | null;
  effort?: string | null;
  source?: string | null;
};

type AttachedSkill = { installedSkill: { id: string } & SkillForPrompt };

type SubAgentChild = {
  id: string;
  name: string;
  slug: string;
  systemPrompt: string | null;
  runtimeKind: string;
};

export type SubAgentRef = { id: string; name: string; slug: string; description: string | null };

export type LoadedAgentTools = {
  servers: { deploymentId: string }[];
  skills: AttachedSkill[];
  toolkits: { toolkit: { servers: { deploymentId: string }[]; skills: AttachedSkill[] } }[];
  sandboxes?: { sandboxId: string; isDefault: boolean; sandbox: { id: string; deploymentId: string } }[];
  knowledgeBases?: { knowledgeBase: { id: string; embeddingModel: string; topK: number; threshold: number; provider: { format: string; baseUrl: string; apiKey: string } | null } }[];
  subAgents?: { child: SubAgentChild }[];
};

export function resolveAgentTools(agent: LoadedAgentTools, sandboxId?: string | null): {
  deploymentIds: string[];
  sandboxDeploymentIds: string[];
  skills: SkillForPrompt[];
  subAgents: SubAgentRef[];
  knowledgeBases?: NonNullable<LoadedAgentTools['knowledgeBases']>;
} {
  const depSet = new Set<string>();
  const sandboxDepSet = new Set<string>();
  const skillMap = new Map<string, SkillForPrompt>();
  for (const s of agent.servers) depSet.add(s.deploymentId);
  for (const s of agent.sandboxes ?? []) {
    if (s.sandboxId !== sandboxId) continue;
    depSet.add(s.sandbox.deploymentId);
    sandboxDepSet.add(s.sandbox.deploymentId);
  }
  for (const s of agent.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) depSet.add(s.deploymentId);
    for (const s of tk.toolkit.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  }
  const skills = [...skillMap.values()].filter((s) => s.agentInvocable !== false);

  const subMap = new Map<string, SubAgentRef>();
  for (const link of agent.subAgents ?? []) {
    const c = link.child;
    subMap.set(c.id, {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.runtimeKind === 'hermes' ? null : c.systemPrompt,
    });
  }

  return {
    deploymentIds: [...depSet],
    sandboxDeploymentIds: [...sandboxDepSet],
    skills,
    subAgents: [...subMap.values()],
    ...(agent.knowledgeBases ? { knowledgeBases: agent.knowledgeBases } : {}),
  };
}
