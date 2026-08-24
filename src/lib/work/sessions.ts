import 'server-only';
import { db } from '@/lib/db';
import { defaultConversationRuntimeSession } from '@/lib/agents/mutations';

type CreateWorkSessionInput = {
  workspaceId: string;
  agentId: string;
  sandboxId?: string;
  task?: string;
};

export async function createWorkSession(input: CreateWorkSessionInput) {
  const task = input.task?.trim() || null;
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: {
        id: true,
        runtime: { select: { sandboxId: true } },
        sandboxes: {
          select: {
            sandboxId: true,
            isDefault: true,
            sandbox: { select: { id: true, name: true, deployment: { select: { status: true } } } },
          },
        },
      },
    });
    if (!agent) return null;

    const link = input.sandboxId
      ? agent.sandboxes.find((item) => item.sandboxId === input.sandboxId)
      : agent.sandboxes.find((item) => item.isDefault) ?? agent.sandboxes[0];
    if (!link || agent.runtime?.sandboxId === link.sandboxId) return null;

    const conversation = await tx.conversation.create({ data: { agentId: agent.id, title: task?.slice(0, 80) ?? null } });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(agent.id, conversation.id),
    });
    return tx.workSession.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        sandboxId: link.sandboxId,
        conversationId: conversation.id,
        task,
        title: task?.slice(0, 80) ?? null,
        status: link.sandbox.deployment.status === 'running' ? 'active' : 'waiting',
      },
      include: { conversation: true, sandbox: { include: { deployment: true } } },
    });
  });
}

export async function listWorkSessions(workspaceId: string, agentId?: string) {
  return db.workSession.findMany({
    where: { workspaceId, status: { not: 'archived' }, ...(agentId ? { agentId } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: {
      agent: { select: { id: true, name: true } },
      sandbox: { select: { id: true, name: true, deploymentId: true, deployment: { select: { status: true } } } },
      conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
    },
  });
}

export async function getWorkSession(
  workspaceId: string,
  workSessionId: string,
  agentId?: string,
  conversationId?: string,
) {
  return db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspaceId,
      ...(agentId ? { agentId } : {}),
      ...(conversationId ? { conversationId } : {}),
    },
    include: {
      sandbox: { include: { deployment: true } },
      conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
    },
  });
}

export async function archiveWorkSession(workspaceId: string, workSessionId: string) {
  const result = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId },
    data: { status: 'archived' },
  });
  return result.count === 1;
}
