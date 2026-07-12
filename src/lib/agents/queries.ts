import 'server-only';
import { db } from '@/lib/db';
import { effectiveStatuses } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';

export type AgentResourceOption = {
  id: string;
  label: string;
  description: string | null;
  source: string;
  status: string;
  keywords: string[];
  checked: boolean;
};

const INSTALLED_SKILL_INCLUDE = {
  include: {
    skill: true,
  },
} as const;

const TOOL_INCLUDE = {
  servers: { select: { deploymentId: true } },
  skills: {
    select: {
      installedSkill: INSTALLED_SKILL_INCLUDE,
    },
  },
  toolkits: {
    select: {
      toolkit: {
        select: {
          id: true,
          name: true,
          servers: { select: { deploymentId: true } },
          skills: {
            select: {
              installedSkill: INSTALLED_SKILL_INCLUDE,
            },
          },
        },
      },
    },
  },
  subAgents: {
    select: {
      child: {
        select: {
          id: true,
          name: true,
          slug: true,
          systemPrompt: true,
          runtime: { select: { kind: true } },
        },
      },
    },
  },
  sandboxes: {
    select: {
      sandbox: { select: { id: true, name: true, slug: true, deploymentId: true } },
    },
  },
  runtime: {
    include: {
      sandbox: { include: { deployment: true } },
    },
  },
} as const;

export async function listProviders(workspaceId: string) {
  return db.modelProvider.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function listAgentDeploymentOptions(
  workspaceId: string,
  selectedIds?: ReadonlySet<string>,
): Promise<AgentResourceOption[]> {
  const deployments = await db.deployment.findMany({
    where: {
      workspaceId,
      OR: [{ source: null }, { source: { not: 'sandbox' } }],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      serverId: true,
      name: true,
      source: true,
      sourceRef: true,
      server: { select: { name: true, slug: true, description: true } },
    },
  });
  const statuses = effectiveStatuses(deployments);

  return deployments.map((deployment) => {
    const label = deploymentLabel(deployment);
    return {
      id: deployment.id,
      label: label.name,
      description: deployment.server?.description ?? label.ref,
      source: label.source,
      status: statuses.get(deployment.id) ?? deployment.status,
      keywords: [deployment.server?.slug ?? '', deployment.sourceRef ?? '', deployment.source ?? '']
        .filter((keyword) => keyword.length > 0),
      checked: selectedIds?.has(deployment.id) ?? false,
    };
  });
}

export async function listAgentSkillOptions(
  workspaceId: string,
  selectedIds?: ReadonlySet<string>,
): Promise<AgentResourceOption[]> {
  const skills = await db.installedSkill.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      skillId: true,
      name: true,
      slug: true,
      description: true,
      source: true,
      sourceRef: true,
      status: true,
      userInvocable: true,
      agentInvocable: true,
      skill: { select: { name: true, slug: true, description: true } },
    },
  });

  return skills.map((skill) => {
    const label = skillLabel(skill);
    return {
      id: skill.id,
      label: label.name,
      description: skill.skill?.description ?? skill.description,
      source: label.source,
      status: skill.status,
      keywords: [
        label.slug,
        skill.sourceRef ?? '',
        skill.source ?? '',
        skill.userInvocable ? 'user' : '',
        skill.agentInvocable ? 'agent' : '',
      ].filter((keyword) => keyword.length > 0),
      checked: selectedIds?.has(skill.id) ?? false,
    };
  });
}

export async function getProvider(workspaceId: string, providerId: string) {
  return db.modelProvider.findFirst({ where: { id: providerId, workspaceId } });
}

export async function getAgentPageData(workspaceId: string, agentId: string) {
  return db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      name: true,
      systemPrompt: true,
      providerId: true,
      model: true,
      maxSteps: true,
      provider: { select: { name: true } },
      servers: { select: { deploymentId: true } },
      skills: { select: { installedSkillId: true } },
      toolkits: { select: { toolkitId: true } },
      sandboxes: { select: { sandboxId: true } },
      subAgents: { select: { childId: true } },
      runtime: {
        select: {
          id: true,
          kind: true,
          image: true,
          status: true,
          lastError: true,
          lastSyncedAt: true,
          sandboxId: true,
          sandbox: {
            select: {
              deploymentId: true,
              deployment: { select: { status: true } },
            },
          },
        },
      },
    },
  });
}

export async function listAgents(workspaceId: string) {
  return db.agent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: {
      provider: { select: { name: true } },
      runtime: {
        select: {
          id: true,
          kind: true,
          image: true,
          status: true,
          lastError: true,
          sandbox: { select: { deploymentId: true, deployment: { select: { status: true } } } },
        },
      },
      _count: {
        select: {
          servers: true,
          skills: true,
          toolkits: true,
          sandboxes: true,
          subAgents: true,
          conversations: true,
        },
      },
    },
  });
}

export async function getAgent(workspaceId: string, agentId: string) {
  return db.agent.findFirst({
    where: { id: agentId, workspaceId },
    include: {
      provider: true,
      ...TOOL_INCLUDE,
      _count: {
        select: {
          conversations: true,
          channels: true,
        },
      },
    },
  });
}

// Used by the chat route: resolves an agent the user may access (owner or member)
// in one query, with provider + tool relations loaded.
export async function getAgentForRequest(agentId: string, userId: string) {
  return db.agent.findFirst({
    where: {
      id: agentId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: { provider: true, ...TOOL_INCLUDE },
  });
}

export async function getHermesTerminalForRequest(agentId: string, userId: string) {
  return db.agent.findFirst({
    where: {
      id: agentId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      runtime: { is: { kind: 'hermes' } },
    },
    select: {
      id: true,
      workspaceId: true,
      runtime: {
        select: {
          id: true,
          sandbox: { select: { deploymentId: true } },
        },
      },
    },
  });
}

// Used by the recursive sub-agent runner: loads a sub-agent scoped to the
// PARENT's workspace, so an agent can only ever delegate to agents in its own
// workspace. Each nesting level loads the next fresh (no deep nested includes).
export async function getAgentForRun(agentId: string, workspaceId: string) {
  return db.agent.findFirst({
    where: { id: agentId, workspaceId },
    include: { provider: true, ...TOOL_INCLUDE },
  });
}

export async function listConversations(agentId: string) {
  return db.conversation.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true, role: true, parts: true },
      },
    },
  });
}

export async function getConversation(conversationId: string, workspaceId: string) {
  return db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
}
