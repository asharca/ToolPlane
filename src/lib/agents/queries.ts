import 'server-only';
import { db } from '@/lib/db';

const TOOL_INCLUDE = {
  servers: { select: { deploymentId: true } },
  skills: {
    select: {
      installedSkill: {
        select: { id: true, skill: { select: { slug: true, name: true, description: true, author: true } } },
      },
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
              installedSkill: {
                select: { id: true, skill: { select: { slug: true, name: true, description: true, author: true } } },
              },
            },
          },
        },
      },
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

export async function listConversations(agentId: string) {
  return db.conversation.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' } });
}

export async function getConversation(conversationId: string, workspaceId: string) {
  return db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
}
