import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
} from '@/lib/attachments/messages';
import {
  chatBranchNavigation,
  chatMessagePath,
  latestChatBranchLeaf,
} from './branches';
import type {
  CreateChatAssistantInput,
  CreateChatThreadInput,
  UpdateChatAssistantInput,
  UpdateChatThreadInput,
} from './schemas';

export const CHAT_TURN_STALE_AFTER_MS = 5 * 60 * 1000;

const providerForClient = {
  select: { id: true, name: true, format: true, models: true },
} as const;

const grantForClient = {
  orderBy: { createdAt: 'asc' as const },
  select: {
    deploymentId: true,
    deployment: {
      select: {
        id: true,
        name: true,
        source: true,
        status: true,
        server: { select: { name: true, slug: true } },
      },
    },
  },
} as const;

export class ChatServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ChatServiceError';
  }
}

type StoredChatMessage = {
  id: string;
  parentId: string | null;
  siblingGroupId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  parts: Prisma.JsonValue;
  createdAt: Date;
};

export type ChatBranchNode = {
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  createdAt: string;
  preview: string;
  active: boolean;
  awaitingInput: boolean;
};

function isAwaitingInput(message: Pick<StoredChatMessage, 'role' | 'parts'>) {
  return message.role === 'user' && Array.isArray(message.parts) && message.parts.length === 0;
}

function projectActiveChatBranch<T extends { activeMessageId: string | null; messages: StoredChatMessage[] }>(
  thread: T | null,
) {
  if (!thread) return null;
  const path = chatMessagePath(thread.messages, thread.activeMessageId);
  const activeIds = new Set(path.map((message) => message.id));
  const parentIds = new Set(thread.messages.flatMap((message) => message.parentId ? [message.parentId] : []));
  const leafCount = thread.messages.filter((message) => !parentIds.has(message.id)).length;
  return {
    ...thread,
    messages: path.filter((message) => !isAwaitingInput(message)),
    branch: {
      activeMessageId: path.at(-1)?.id ?? null,
      branchCount: leafCount,
      navigation: chatBranchNavigation(thread.messages, path),
      nodes: thread.messages.map<ChatBranchNode>((message) => ({
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        status: message.status,
        modelId: message.modelId,
        createdAt: message.createdAt.toISOString(),
        preview: messageTitle(Array.isArray(message.parts) ? message.parts as Array<Record<string, unknown>> : [])
          ?? (message.role === 'user' ? 'User message' : 'Assistant message'),
        active: activeIds.has(message.id),
        awaitingInput: isAwaitingInput(message),
      })),
    },
  };
}

async function requireWorkspace(userId: string, workspaceId: string) {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) throw new ChatServiceError(404, 'Workspace not found');
  return workspace;
}

async function validateAssistantResources(
  workspaceId: string,
  input: Pick<UpdateChatAssistantInput, 'modelProviderId' | 'deploymentIds'>,
) {
  if (input.modelProviderId) {
    const provider = await db.modelProvider.findFirst({
      where: { id: input.modelProviderId, workspaceId },
      select: { id: true },
    });
    if (!provider) throw new ChatServiceError(400, 'Model provider not found');
  }

  if (input.deploymentIds !== undefined) {
    const deployments = await db.deployment.findMany({
      where: {
        id: { in: input.deploymentIds },
        workspaceId,
        sandbox: { is: null },
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
      select: { id: true },
    });
    if (deployments.length !== input.deploymentIds.length) {
      throw new ChatServiceError(400, 'One or more MCP deployments are invalid');
    }
  }
}

// Server Components call this after resolving an authorized workspace.
export async function listChatAssistantsForWorkspace(workspaceId: string) {
  return db.chatAssistant.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      threads: {
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, role: true, parts: true, createdAt: true },
          },
        },
      },
    },
  });
}

export async function listChatAssistantsForUser(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  return listChatAssistantsForWorkspace(workspaceId);
}

export async function getChatAssistantForWorkspace(workspaceId: string, assistantId: string) {
  return db.chatAssistant.findFirst({
    where: { id: assistantId, workspaceId },
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      threads: {
        orderBy: { updatedAt: 'desc' },
        take: 50,
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
}

export async function getChatAssistantForUser(userId: string, assistantId: string) {
  return db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      threads: {
        orderBy: { updatedAt: 'desc' },
        take: 50,
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
    },
  });
}

export async function createChatAssistant(userId: string, input: CreateChatAssistantInput) {
  await requireWorkspace(userId, input.workspaceId);
  await validateAssistantResources(input.workspaceId, input);
  return db.chatAssistant.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      systemPrompt: input.systemPrompt ?? null,
      modelProviderId: input.modelProviderId ?? null,
      model: input.model ?? null,
      maxSteps: input.maxSteps ?? 8,
      mcpGrants: {
        create: (input.deploymentIds ?? []).map((deploymentId) => ({ deploymentId })),
      },
    },
    include: { modelProvider: providerForClient, mcpGrants: grantForClient },
  });
}

export async function updateChatAssistant(
  userId: string,
  assistantId: string,
  input: UpdateChatAssistantInput,
) {
  const assistant = await db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    select: { id: true, workspaceId: true },
  });
  if (!assistant) throw new ChatServiceError(404, 'Chat assistant not found');
  await validateAssistantResources(assistant.workspaceId, input);

  return db.$transaction(async (tx) => {
    if (input.deploymentIds !== undefined) {
      await tx.chatAssistantMcpGrant.deleteMany({ where: { assistantId } });
      if (input.deploymentIds.length) {
        await tx.chatAssistantMcpGrant.createMany({
          data: input.deploymentIds.map((deploymentId) => ({ assistantId, deploymentId })),
        });
      }
    }
    return tx.chatAssistant.update({
      where: { id: assistantId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.modelProviderId !== undefined
          ? { modelProviderId: input.modelProviderId, ...(input.modelProviderId === null && input.model === undefined ? { model: null } : {}) }
          : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      },
      include: { modelProvider: providerForClient, mcpGrants: grantForClient },
    });
  });
}

export async function deleteChatAssistant(userId: string, assistantId: string) {
  const result = await db.chatAssistant.deleteMany({
    where: {
      id: assistantId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
  });
  if (!result.count) throw new ChatServiceError(404, 'Chat assistant not found');
}

export async function createChatThread(
  userId: string,
  assistantId: string,
  input: CreateChatThreadInput,
) {
  const assistant = await db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    select: { id: true, workspaceId: true },
  });
  if (!assistant) throw new ChatServiceError(404, 'Chat assistant not found');
  return db.chatThread.create({
    data: { workspaceId: assistant.workspaceId, assistantId, title: input.title ?? null },
  });
}

// Server Components call this after resolving an authorized workspace.
export async function getChatThreadForWorkspace(
  workspaceId: string,
  assistantId: string,
  threadId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, workspaceId, assistantId },
    include: {
      assistant: {
        include: { modelProvider: providerForClient, mcpGrants: grantForClient },
      },
      messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      turns: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  return projectActiveChatBranch(thread);
}

export async function getChatThreadForUser(userId: string, threadId: string) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: {
      assistant: {
        include: { modelProvider: providerForClient, mcpGrants: grantForClient },
      },
      messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      turns: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  return projectActiveChatBranch(thread);
}

export async function updateChatThread(userId: string, threadId: string, input: UpdateChatThreadInput) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, 'Chat thread not found');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`);
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        messages: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, parentId: true, siblingGroupId: true, role: true },
        },
      },
    });
    if (!thread) throw new ChatServiceError(404, 'Chat thread not found');
    const activeMessageId = input.activeMessageId
      ? latestChatBranchLeaf(thread.messages, input.activeMessageId)
      : null;
    if (input.activeMessageId && !activeMessageId) {
      throw new ChatServiceError(404, 'Chat message not found');
    }
    return tx.chatThread.update({
      where: { id: threadId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.activeMessageId !== undefined ? { activeMessageId } : {}),
      },
    });
  });
}

export async function reserveChatBranch(userId: string, threadId: string, anchorMessageId: string) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, 'Chat thread not found');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`);
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        activeMessageId: true,
        turns: {
          where: {
            status: 'pending',
            createdAt: { gte: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS) },
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!thread) throw new ChatServiceError(404, 'Chat thread not found');

    const anchor = await tx.chatMessage.findFirst({
      where: { id: anchorMessageId, threadId, role: 'assistant' },
      select: {
        id: true,
        children: {
          where: { role: 'user' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!anchor) throw new ChatServiceError(400, 'A branch must start from an assistant message');

    const turn = await tx.chatTurn.create({
      data: { threadId, status: 'completed', completedAt: new Date() },
    });
    const reservations = [];
    const reservationCount = anchor.children.length ? 1 : 2;
    for (let index = 0; index < reservationCount; index += 1) {
      reservations.push(await tx.chatMessage.create({
        data: {
          threadId,
          turnId: turn.id,
          parentId: anchor.id,
          role: 'user',
          parts: [] as Prisma.InputJsonValue,
        },
      }));
    }

    const activated = thread.turns.length === 0;
    const activeMessageId = activated ? reservations.at(-1)!.id : thread.activeMessageId;
    await tx.chatThread.update({
      where: { id: threadId },
      data: { activeMessageId, updatedAt: new Date() },
    });
    return { messages: reservations, activeMessageId, activated };
  });
}

export async function deleteReservedChatBranch(userId: string, threadId: string, messageId: string) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, 'Chat thread not found');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`);
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: { id: true, activeMessageId: true },
    });
    if (!thread) throw new ChatServiceError(404, 'Chat thread not found');

    const message = await tx.chatMessage.findFirst({
      where: { id: messageId, threadId },
      select: {
        id: true,
        parentId: true,
        role: true,
        parts: true,
        children: { take: 1, select: { id: true } },
      },
    });
    if (
      !message
      || message.role !== 'user'
      || !Array.isArray(message.parts)
      || message.parts.length > 0
      || message.children.length > 0
    ) {
      throw new ChatServiceError(400, 'Only an empty branch can be deleted');
    }

    await tx.chatMessage.delete({ where: { id: message.id } });
    const activeMessageId = thread.activeMessageId === message.id ? message.parentId : thread.activeMessageId;
    await tx.chatThread.update({
      where: { id: threadId },
      data: { activeMessageId, updatedAt: new Date() },
    });
    return { activeMessageId };
  });
}

export async function deleteChatThread(userId: string, threadId: string) {
  const result = await db.chatThread.deleteMany({
    where: {
      id: threadId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
  });
  if (!result.count) throw new ChatServiceError(404, 'Chat thread not found');
}

export async function getChatThreadForExecution(userId: string, threadId: string) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: {
      assistant: {
        include: {
          modelProvider: true,
          mcpGrants: {
            where: {
              deployment: {
                sandbox: { is: null },
                OR: [{ source: null }, { source: { not: 'sandbox' } }],
              },
            },
            select: { deploymentId: true },
          },
        },
      },
      messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  return projectActiveChatBranch(thread);
}

function messageTitle(parts: Array<Record<string, unknown>>): string | null {
  const text = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ');
  return text ? text.slice(0, 80) : null;
}

export async function beginChatTurn(
  threadId: string,
  parts: Array<Record<string, unknown>>,
  attachmentOwner: { workspaceId: string; userId: string },
  request: {
    trigger?: 'submit-message' | 'regenerate-message';
    messageId?: string;
    clientLastMessageId?: string;
    modelId?: string;
  } = {},
) {
  const trigger = request.trigger ?? 'submit-message';
  const attachmentIds = trigger === 'submit-message' ? attachmentIdsFromParts(parts) : [];
  const authorizedThread = await db.chatThread.findFirst({
    where: { id: threadId, workspaceId: attachmentOwner.workspaceId },
    select: { id: true },
  });
  if (!authorizedThread) throw new ChatServiceError(404, 'Chat thread not found');
  const now = new Date();
  await db.chatTurn.updateMany({
    where: {
      threadId,
      status: 'pending',
      createdAt: { lt: new Date(now.getTime() - CHAT_TURN_STALE_AFTER_MS) },
    },
    data: {
      status: 'failed',
      error: 'Chat turn expired before completion.',
      completedAt: now,
    },
  });
  await db.chatMessage.updateMany({
    where: { threadId, status: 'pending', turn: { status: 'failed' } },
    data: { status: 'failed' },
  });

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`);
      const thread = await tx.chatThread.findUnique({
        where: { id: threadId },
        select: { activeMessageId: true, title: true, workspaceId: true },
      });
      if (!thread || thread.workspaceId !== attachmentOwner.workspaceId) {
        throw new ChatServiceError(404, 'Chat thread not found');
      }

      const targetId = request.messageId
        ?? (trigger === 'regenerate-message' ? request.clientLastMessageId : undefined);
      const target = targetId
        ? await tx.chatMessage.findFirst({
            where: { id: targetId, threadId },
            select: {
              id: true,
              parentId: true,
              siblingGroupId: true,
              turnId: true,
              role: true,
              status: true,
              parts: true,
            },
          })
        : null;
      if (targetId && !target) throw new ChatServiceError(404, 'Chat message not found');

      const turn = await tx.chatTurn.create({ data: { threadId } });
      let assistantParentId: string;
      let historyLeafId: string;
      let assistantMessageId: string;

      if (trigger === 'regenerate-message') {
        if (!target || (target.role !== 'assistant' && target.role !== 'user')) {
          throw new ChatServiceError(400, 'A user or assistant message is required for regeneration');
        }
        assistantParentId = target.role === 'assistant' ? target.parentId ?? '' : target.id;
        if (!assistantParentId) throw new ChatServiceError(400, 'The selected message cannot be regenerated');
        historyLeafId = assistantParentId;

        const retryInPlace = target.role === 'assistant'
          && (target.status !== 'success' || (Array.isArray(target.parts) && target.parts.length === 0));
        if (retryInPlace) {
          await tx.chatMessage.update({
            where: { id: target.id },
            data: {
              turnId: turn.id,
              status: 'pending',
              modelId: request.modelId ?? null,
              parts: [] as Prisma.InputJsonValue,
            },
          });
          assistantMessageId = target.id;
        } else {
          let siblingGroupId = target.role === 'assistant'
            ? target.siblingGroupId ?? turn.id
            : null;
          if (target.role === 'assistant' && !target.siblingGroupId) {
            await tx.chatMessage.update({
              where: { id: target.id },
              data: { siblingGroupId },
            });
          } else if (target.role === 'user') {
            const assistantSiblings = await tx.chatMessage.findMany({
              where: { threadId, parentId: target.id, role: 'assistant' },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, siblingGroupId: true },
            });
            if (assistantSiblings.length) {
              siblingGroupId = assistantSiblings.find((message) => message.siblingGroupId)?.siblingGroupId ?? turn.id;
              await tx.chatMessage.updateMany({
                where: {
                  id: { in: assistantSiblings.map((message) => message.id) },
                  siblingGroupId: null,
                },
                data: { siblingGroupId },
              });
            }
          }
          const assistantMessage = await tx.chatMessage.create({
            data: {
              threadId,
              turnId: turn.id,
              parentId: assistantParentId,
              siblingGroupId,
              role: 'assistant',
              status: 'pending',
              modelId: request.modelId ?? null,
              parts: [] as Prisma.InputJsonValue,
            },
          });
          assistantMessageId = assistantMessage.id;
        }
      } else {
        if (request.messageId && target?.role !== 'user') {
          throw new ChatServiceError(400, 'Only user messages can be edited and resent');
        }
        await claimWorkspaceAttachments(tx, {
          ids: attachmentIds,
          workspaceId: attachmentOwner.workspaceId,
          uploadedById: attachmentOwner.userId,
          scope: { chatThreadId: threadId },
        });
        const activePlaceholder = !target && thread.activeMessageId
          ? await tx.chatMessage.findFirst({
              where: {
                id: thread.activeMessageId,
                threadId,
                role: 'user',
                parts: { equals: [] },
              },
              select: { id: true },
            })
          : null;
        let userMessage: { id: string };
        if (activePlaceholder) {
          userMessage = await tx.chatMessage.update({
            where: { id: activePlaceholder.id },
            data: {
              turnId: turn.id,
              status: 'success',
              parts: parts as Prisma.InputJsonValue,
            },
          });
        } else {
          const siblingGroupId = target ? target.siblingGroupId ?? turn.id : null;
          if (target && !target.siblingGroupId) {
            await tx.chatMessage.update({
              where: { id: target.id },
              data: { siblingGroupId },
            });
          }
          userMessage = await tx.chatMessage.create({
            data: {
              threadId,
              turnId: turn.id,
              parentId: target ? target.parentId : thread.activeMessageId,
              siblingGroupId,
              role: 'user',
              parts: parts as Prisma.InputJsonValue,
            },
          });
        }
        assistantParentId = userMessage.id;
        historyLeafId = userMessage.id;
        const assistantMessage = await tx.chatMessage.create({
          data: {
            threadId,
            turnId: turn.id,
            parentId: assistantParentId,
            role: 'assistant',
            status: 'pending',
            modelId: request.modelId ?? null,
            parts: [] as Prisma.InputJsonValue,
          },
        });
        assistantMessageId = assistantMessage.id;
      }

      await tx.chatThread.update({
        where: { id: threadId },
        data: {
          activeMessageId: assistantMessageId,
          updatedAt: new Date(),
          ...(!thread.title && trigger === 'submit-message' ? { title: messageTitle(parts) } : {}),
        },
      });
      return { ...turn, assistantMessageId, assistantParentId, historyLeafId };
    });
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'P2002'
    ) {
      throw new ChatServiceError(409, 'A chat turn is already running');
    }
    throw error;
  }
}

export async function getChatHistoryForExecution(userId: string, threadId: string, leafMessageId: string) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    select: {
      messages: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, parentId: true, role: true, parts: true, createdAt: true },
      },
    },
  });
  if (!thread) throw new ChatServiceError(404, 'Chat thread not found');
  const path = chatMessagePath(thread.messages, leafMessageId);
  if (path.at(-1)?.id !== leafMessageId) throw new ChatServiceError(404, 'Chat message not found');
  return path;
}

export async function completeChatTurn(
  threadId: string,
  turnId: string,
  assistantMessageId: string,
  parts: Array<Record<string, unknown>>,
) {
  return db.$transaction(async (tx) => {
    const updated = await tx.chatTurn.updateMany({
      where: { id: turnId, threadId, status: 'pending' },
      data: { status: 'completed', error: null, completedAt: new Date() },
    });
    if (!updated.count) return false;
    const message = await tx.chatMessage.updateMany({
      where: { id: assistantMessageId, threadId, turnId, role: 'assistant', status: 'pending' },
      data: { status: 'success', parts: parts as Prisma.InputJsonValue },
    });
    if (message.count !== 1) throw new ChatServiceError(409, 'Chat response is no longer pending');
    await tx.chatThread.updateMany({
      where: { id: threadId, activeMessageId: assistantMessageId },
      data: { updatedAt: new Date() },
    });
    return true;
  });
}

export async function finishChatTurn(
  threadId: string,
  turnId: string,
  status: 'failed' | 'cancelled',
  error?: string,
  assistantMessageId?: string,
) {
  return db.$transaction(async (tx) => {
    const turn = await tx.chatTurn.updateMany({
      where: { id: turnId, threadId, status: 'pending' },
      data: {
        status,
        error: error?.slice(0, 500) ?? null,
        completedAt: new Date(),
      },
    });
    if (!turn.count) return false;
    if (assistantMessageId) {
      const message = await tx.chatMessage.updateMany({
        where: { id: assistantMessageId, threadId, turnId, status: 'pending' },
        data: { status },
      });
      if (message.count !== 1) throw new ChatServiceError(409, 'Chat response is no longer pending');
    }
    return true;
  });
}
