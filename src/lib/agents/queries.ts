import 'server-only';
import { db } from '@/lib/db';
import { effectiveStatuses } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import {
  parseAgentMarketSetupGuide,
  parseAgentMarketSetupResourceIds,
  type AgentMarketSetupGuide,
} from '@/lib/agents/market-setup';
import { AGENT_ENDPOINT_RUNTIME_MANAGED_BY } from '@/lib/agents/public-api/tool-policy';

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
  modelProviders: {
    include: { provider: true },
    orderBy: { provider: { createdAt: 'asc' } },
  },
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
          runtimeKind: true,
          runtime: { select: { kind: true } },
        },
      },
    },
  },
  sandboxes: {
    select: {
      sandboxId: true,
      isDefault: true,
      sandbox: { select: { id: true, name: true, slug: true, kind: true, network: true, deploymentId: true } },
    },
  },
  knowledgeBases: {
    select: {
      knowledgeBase: {
        select: {
          id: true,
          embeddingModel: true,
          topK: true,
          threshold: true,
          provider: { select: { format: true, baseUrl: true, apiKey: true } },
        },
      },
    },
  },
  runtime: {
    include: {
      sandbox: { include: { deployment: true } },
    },
  },
  // Internal lifecycle/execution callers need the immutable public revision
  // that owns an isolated runtime. Ordinary list/detail/request queries below
  // explicitly exclude these hidden runtime Agents.
  publicRuntimeAllocation: {
    select: {
      id: true,
      revisionId: true,
      revision: {
        select: {
          systemPrompt: true,
          deploymentIds: true,
          toolPolicy: true,
        },
      },
    },
  },
} as const;

// The relation is the primary visibility boundary. The durable sandbox marker
// keeps the Agent hidden (and fail-closed in the runtime MCP route) if an
// Endpoint/allocation is deleted before its runtime resources are collected.
const ORDINARY_AGENT_FILTER = {
  publicRuntimeAllocation: { is: null },
  NOT: {
    runtime: {
      is: {
        sandbox: {
          config: {
            path: ['managedBy'],
            equals: AGENT_ENDPOINT_RUNTIME_MANAGED_BY,
          },
        },
      },
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
    where: {
      id: agentId,
      workspaceId,
      ...ORDINARY_AGENT_FILTER,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      runtimeKind: true,
      systemPrompt: true,
      providerId: true,
      model: true,
      maxSteps: true,
      provider: { select: { name: true } },
      modelProviders: {
        orderBy: { provider: { createdAt: 'asc' } },
        select: {
          providerId: true,
          provider: { select: { name: true, models: true } },
        },
      },
      servers: { select: { deploymentId: true } },
      skills: { select: { installedSkillId: true } },
      toolkits: { select: { toolkitId: true } },
      sandboxes: {
        select: {
          sandboxId: true,
          isDefault: true,
          sandbox: { select: { kind: true, network: true } },
        },
      },
      subAgents: { select: { childId: true } },
      marketInstall: {
        select: {
          status: true,
          requirements: true,
          resourceMap: true,
        },
      },
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
              config: true,
              deploymentId: true,
              deployment: { select: { status: true } },
            },
          },
        },
      },
    },
  });
}

/**
 * Recomputes marketplace setup against current workspace-owned resources.
 * Provider credentials are never selected, and deployment environment values
 * remain server-side inputs to the client-safe guide parser.
 */
export async function resolveAgentMarketSetupGuide(
  workspaceId: string,
  input: unknown,
): Promise<AgentMarketSetupGuide | null> {
  const resourceIds = parseAgentMarketSetupResourceIds(input);
  if (!resourceIds) return null;

  const [agents, deployments] = await Promise.all([
    resourceIds.agentIds.length > 0
      ? db.agent.findMany({
          where: { workspaceId, id: { in: resourceIds.agentIds } },
          select: {
            id: true,
            model: true,
            provider: { select: { format: true } },
          },
        })
      : Promise.resolve([]),
    resourceIds.deploymentIds.length > 0
      ? db.deployment.findMany({
          where: { workspaceId, id: { in: resourceIds.deploymentIds } },
          select: { id: true, installCfg: true },
        })
      : Promise.resolve([]),
  ]);

  return parseAgentMarketSetupGuide(input, { agents, deployments });
}

export async function listAgents(workspaceId: string) {
  return db.agent.findMany({
    where: { workspaceId, ...ORDINARY_AGENT_FILTER },
    orderBy: { createdAt: 'desc' },
    include: {
      provider: { select: { name: true } },
      modelProviders: {
        orderBy: { provider: { createdAt: 'asc' } },
        select: {
          providerId: true,
          provider: { select: { name: true, models: true } },
        },
      },
      runtime: {
        select: {
          id: true,
          kind: true,
          image: true,
          status: true,
          lastError: true,
          sandbox: {
            select: {
              id: true,
              name: true,
              kind: true,
              network: true,
              deploymentId: true,
              deployment: { select: { status: true } },
            },
          },
        },
      },
      sandboxes: {
        select: {
          sandboxId: true,
          isDefault: true,
          sandbox: {
            select: {
              id: true,
              name: true,
              kind: true,
              network: true,
              deploymentId: true,
              deployment: { select: { status: true } },
            },
          },
        },
      },
      _count: {
        select: {
          servers: true,
          skills: true,
          toolkits: true,
          sandboxes: true,
          subAgents: true,
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
      ...ORDINARY_AGENT_FILTER,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: { provider: true, ...TOOL_INCLUDE },
  });
}

export async function getHermesTerminalForRequest(agentId: string, userId: string) {
  return db.agent.findFirst({
    where: {
      id: agentId,
      ...ORDINARY_AGENT_FILTER,
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
    where: {
      id: agentId,
      workspaceId,
      ...ORDINARY_AGENT_FILTER,
    },
    include: { provider: true, ...TOOL_INCLUDE },
  });
}

// Explicit internal loader for the public execution path. Unlike
// getAgentForRun, this requires the hidden Agent to be linked to the exact
// ready allocation, so it cannot become a general sub-agent escape hatch.
export async function getAgentEndpointRuntimeForExecution(
  workspaceId: string,
  agentId: string,
  allocationId: string,
) {
  return db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId,
      publicRuntimeAllocation: {
        is: { id: allocationId, status: 'ready' },
      },
    },
    include: { provider: true, ...TOOL_INCLUDE },
  });
}

export async function listConversations(workspaceId: string, agentIds: string[]) {
  return db.conversation.findMany({
    where: { agentId: { in: agentIds }, agent: { workspaceId }, workSession: null },
    orderBy: { createdAt: 'desc' },
    include: {
      publicApiConversation: { select: { id: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
}

export async function getConversation(conversationId: string, workspaceId: string) {
  return db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId } },
    include: { messages: { orderBy: { createdAt: 'asc' } }, workSession: { select: { id: true } } },
  });
}
