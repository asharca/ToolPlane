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
};

type AttachedSkill = { installedSkill: { id: string } & SkillForPrompt };

type SubAgentChild = { id: string; name: string; slug: string; systemPrompt: string | null };
type LinkedDeployment = {
  id: string;
  source: string | null;
  installCfg: unknown;
};

export type SubAgentRef = { id: string; name: string; slug: string; description: string | null };

export type LoadedAgentTools = {
  servers: { deploymentId: string; deployment?: LinkedDeployment | null }[];
  skills: AttachedSkill[];
  toolkits: { toolkit: { servers: { deploymentId: string; deployment?: LinkedDeployment | null }[]; skills: AttachedSkill[] } }[];
  sandboxes?: { sandbox: { deploymentId: string } }[];
  subAgents?: { child: SubAgentChild }[];
};

function linkedSandboxDeploymentId(deployment?: LinkedDeployment | null): string | null {
  if (deployment?.source !== 'sandbox-mcp') return null;
  const cfg = (deployment.installCfg ?? {}) as { sandboxDeploymentId?: unknown };
  return typeof cfg.sandboxDeploymentId === 'string' && cfg.sandboxDeploymentId ? cfg.sandboxDeploymentId : null;
}

export function resolveAgentTools(agent: LoadedAgentTools): {
  deploymentIds: string[];
  sandboxDeploymentIds: string[];
  skills: SkillForPrompt[];
  subAgents: SubAgentRef[];
} {
  const depSet = new Set<string>();
  const sandboxDepSet = new Set<string>();
  const skillMap = new Map<string, SkillForPrompt>();
  for (const s of agent.servers) {
    depSet.add(s.deploymentId);
    const linked = linkedSandboxDeploymentId(s.deployment);
    if (linked) sandboxDepSet.add(linked);
  }
  for (const s of agent.sandboxes ?? []) {
    depSet.add(s.sandbox.deploymentId);
    sandboxDepSet.add(s.sandbox.deploymentId);
  }
  for (const s of agent.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) {
      depSet.add(s.deploymentId);
      const linked = linkedSandboxDeploymentId(s.deployment);
      if (linked) sandboxDepSet.add(linked);
    }
    for (const s of tk.toolkit.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  }
  const skills = [...skillMap.values()].filter((s) => s.agentInvocable !== false);

  const subMap = new Map<string, SubAgentRef>();
  for (const link of agent.subAgents ?? []) {
    const c = link.child;
    subMap.set(c.id, { id: c.id, name: c.name, slug: c.slug, description: c.systemPrompt });
  }

  return { deploymentIds: [...depSet], sandboxDeploymentIds: [...sandboxDepSet], skills, subAgents: [...subMap.values()] };
}
