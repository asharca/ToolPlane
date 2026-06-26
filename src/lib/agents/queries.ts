import 'server-only';
import { db } from '@/lib/db';

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
      child: { select: { id: true, name: true, slug: true, systemPrompt: true } },
    },
  },
} as const;

export async function listProviders(workspaceId: string) {
  return db.modelProvider.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function getProvider(workspaceId: string, providerId: string) {
  return db.modelProvider.findFirst({ where: { id: providerId, workspaceId } });
}

export async function listAgents(workspaceId: string) {
  return db.agent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { provider: { select: { name: true } }, _count: { select: { servers: true, skills: true, toolkits: true } } },
  });
}

export async function getAgent(workspaceId: string, agentId: string) {
  return db.agent.findFirst({
    where: { id: agentId, workspaceId },
    include: { provider: true, ...TOOL_INCLUDE },
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
  return db.conversation.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' } });
}

export async function getConversation(conversationId: string, workspaceId: string) {
  return db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
}
