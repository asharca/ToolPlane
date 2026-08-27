import 'server-only';
import { posix } from 'node:path';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { defaultConversationRuntimeSession } from '@/lib/agents/mutations';
import { isWorkRuntimeKind } from '@/lib/agents/runtime-kind';
import {
  claimWorkAttachments,
  workMessageParts,
  type PreparedWorkAttachment,
} from '@/lib/attachments/work';
import {
  allowedWorkSessionSources,
  type WorkSessionStatus,
} from '@/lib/work/state-machine';

type CreateWorkSessionInput = {
  workspaceId: string;
  uploadedById?: string;
  agentId: string;
  sandboxId?: string;
  task: string;
  acceptanceCriteria?: string;
  maxSteps?: number;
  workingDirectory?: string;
  attachments?: PreparedWorkAttachment[];
};

export type WorkSessionTransitionResult =
  | { ok: true; changed: boolean; status: WorkSessionStatus }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_input' }
  | { ok: false; reason: 'invalid_transition'; status: string };

const workSessionClientInclude = {
  agent: { select: { id: true, name: true } },
  sandbox: {
    select: {
      id: true,
      name: true,
      kind: true,
      deploymentId: true,
      deployment: { select: { status: true } },
    },
  },
  conversation: { include: { messages: { orderBy: { createdAt: 'asc' as const } } } },
  approvals: { orderBy: { requestedAt: 'desc' as const } },
} as const;

const workSessionSummaryInclude = {
  agent: { select: { id: true, name: true } },
  sandbox: {
    select: {
      id: true,
      name: true,
      kind: true,
      deploymentId: true,
      deployment: { select: { status: true } },
    },
  },
} as const;

export function normalizeWorkDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1_000 || value.includes('\0')) return null;
  const input = value.trim().replace(/\\/g, '/').replace(/^\/(?:opt\/data\/workspace|workspace)(?:\/|$)/, '') || '.';
  if (input.startsWith('/')) return null;
  const normalized = posix.normalize(input);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

export function workSessionWorkingDirectory(value: Prisma.JsonValue | null): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '.';
  return normalizeWorkDirectory((value as { workingDirectory?: unknown }).workingDirectory) ?? '.';
}

export async function createWorkSession(input: CreateWorkSessionInput) {
  const task = input.task.trim();
  if (!task || task.length > 20_000) return null;
  const workingDirectory = normalizeWorkDirectory(input.workingDirectory ?? '.');
  if (!workingDirectory) return null;
  const acceptanceCriteria = input.acceptanceCriteria?.trim().slice(0, 20_000) || null;
  const maxSteps = Math.min(100, Math.max(1, Math.trunc(input.maxSteps ?? 12)));
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: {
        id: true,
        providerId: true,
        model: true,
        runtimeKind: true,
        systemPrompt: true,
        maxSteps: true,
        modelProviders: { take: 1, select: { providerId: true } },
        runtime: {
          select: {
            id: true,
            kind: true,
            sandboxId: true,
            sandbox: { select: { id: true, workspaceId: true, kind: true, network: true } },
          },
        },
        servers: { select: { deploymentId: true } },
        skills: { select: { installedSkillId: true } },
        toolkits: {
          select: {
            toolkitId: true,
            toolkit: {
              select: {
                servers: { select: { deploymentId: true } },
                skills: { select: { installedSkillId: true } },
              },
            },
          },
        },
        knowledgeBases: { select: { knowledgeBaseId: true } },
        sandboxes: {
          where: { sandbox: { workspaceId: input.workspaceId } },
          select: {
            sandboxId: true,
            isDefault: true,
            sandbox: { select: { kind: true, network: true } },
          },
        },
      },
    });
    if (!agent || !isWorkRuntimeKind(agent.runtimeKind)) return null;

    let sandboxId: string;
    if (agent.runtimeKind === 'hermes') {
      const runtime = agent.runtime;
      if (
        runtime?.kind !== 'hermes'
        || runtime.sandbox.workspaceId !== input.workspaceId
        || runtime.sandbox.kind !== 'hermes'
        || runtime.sandbox.network === 'none'
        || agent.modelProviders.length === 0
        || (input.sandboxId && input.sandboxId !== runtime.sandboxId)
      ) return null;
      sandboxId = runtime.sandboxId;
    } else {
      if (agent.sandboxes.length !== 1) return null;
      const link = agent.sandboxes[0];
      if (
        !link
        || (input.sandboxId && input.sandboxId !== link.sandboxId)
        || agent.runtime?.sandboxId === link.sandboxId
        || link.sandbox.kind !== 'docker'
        || link.sandbox.network === 'none'
      ) return null;
      sandboxId = link.sandboxId;
    }

    const conversation = await tx.conversation.create({
      data: { agentId: agent.id, title: task.slice(0, 80) },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(agent.id, conversation.id),
    });
    const attachments = input.attachments ?? [];
    if (attachments.length) {
      if (!input.uploadedById) return null;
      await claimWorkAttachments(tx, {
        workspaceId: input.workspaceId,
        userId: input.uploadedById,
        conversationId: conversation.id,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        parts: workMessageParts(task, attachments),
        textCharacters: task.length,
      },
    });
    return tx.workSession.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        sandboxId,
        conversationId: conversation.id,
        task,
        title: task.slice(0, 80),
        acceptanceCriteria,
        runtimeKind: agent.runtimeKind,
        runtimeSnapshot: {
          providerId: agent.providerId,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          agentMaxSteps: agent.maxSteps,
          deploymentIds: [...new Set([
            ...agent.servers.map((item) => item.deploymentId),
            ...agent.toolkits.flatMap((item) => item.toolkit.servers.map((server) => server.deploymentId)),
          ])],
          installedSkillIds: [...new Set([
            ...agent.skills.map((item) => item.installedSkillId),
            ...agent.toolkits.flatMap((item) => item.toolkit.skills.map((skill) => skill.installedSkillId)),
          ])],
          knowledgeBaseIds: agent.knowledgeBases.map((item) => item.knowledgeBaseId),
          sandboxId,
          runtimeId: agent.runtime?.id ?? null,
          workingDirectory,
        },
        status: 'queued',
        maxSteps,
      },
      include: { conversation: true, sandbox: { include: { deployment: true } } },
    });
  });
}

export async function transitionWorkSession(
  workspaceId: string,
  workSessionId: string,
  status: WorkSessionStatus,
  data: Prisma.WorkSessionUpdateManyMutationInput = {},
): Promise<WorkSessionTransitionResult> {
  const sources = allowedWorkSessionSources(status).filter((source) => source !== status);
  const updated = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId, status: { in: sources } },
    data: { status, ...data },
  });
  if (updated.count === 1) return { ok: true, changed: true, status };

  const current = await db.workSession.findFirst({
    where: { id: workSessionId, workspaceId },
    select: { status: true },
  });
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.status === status) return { ok: true, changed: false, status };
  return { ok: false, reason: 'invalid_transition', status: current.status };
}

export function startWorkSession(workspaceId: string, workSessionId: string) {
  return transitionWorkSession(workspaceId, workSessionId, 'running', {
    error: null,
    waitingQuestion: null,
    startedAt: new Date(),
  });
}

export function waitForWorkSessionUser(workspaceId: string, workSessionId: string, question?: string) {
  return transitionWorkSession(workspaceId, workSessionId, 'waiting_user', {
    waitingQuestion: question?.trim().slice(0, 20_000) || null,
  });
}

export function waitForWorkSessionApproval(workspaceId: string, workSessionId: string) {
  return transitionWorkSession(workspaceId, workSessionId, 'waiting_approval');
}

export function failWorkSession(workspaceId: string, workSessionId: string, error: string) {
  return transitionWorkSession(workspaceId, workSessionId, 'failed', {
    error: error.trim().slice(0, 500) || 'Work failed.',
    completedAt: new Date(),
  });
}

export function cancelWorkSession(workspaceId: string, workSessionId: string) {
  const now = new Date();
  return db.$transaction(async (tx): Promise<WorkSessionTransitionResult> => {
    const cancelling = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: { in: ['running', 'waiting_approval'] },
      },
      data: { status: 'cancelling', cancelRequestedAt: now },
    });
    if (cancelling.count) {
      await tx.workApproval.updateMany({
        where: { workSessionId, status: 'pending' },
        data: { status: 'expired', resolvedAt: now },
      });
      return { ok: true, changed: true, status: 'cancelling' };
    }
    const stopped = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: { in: ['queued', 'waiting_user'] },
      },
      data: {
        status: 'idle',
        error: null,
        waitingQuestion: null,
        cancelRequestedAt: now,
        completedAt: now,
      },
    });
    if (stopped.count) return { ok: true, changed: true, status: 'idle' };
    const current = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: { status: true },
    });
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === 'cancelling' || current.status === 'cancelled') {
      return { ok: true, changed: false, status: current.status as WorkSessionStatus };
    }
    return { ok: false, reason: 'invalid_transition', status: current.status };
  });
}

export async function finalizeWorkSessionCancellation(workspaceId: string, workSessionId: string) {
  const result = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId, status: 'cancelling' },
    data: { status: 'idle', error: null, waitingQuestion: null, completedAt: new Date() },
  });
  return result.count === 1;
}

export async function resumeWorkSession(
  workspaceId: string,
  workSessionId: string,
): Promise<WorkSessionTransitionResult> {
  const updated = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId, status: 'failed' },
    data: {
      status: 'queued',
      result: null,
      error: null,
      waitingQuestion: null,
      completedAt: null,
      cancelRequestedAt: null,
      stepCount: 0,
      deadlineAt: null,
    },
  });
  if (updated.count === 1) return { ok: true, changed: true, status: 'queued' };
  const current = await db.workSession.findFirst({
    where: { id: workSessionId, workspaceId },
    select: { status: true },
  });
  if (!current) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: 'invalid_transition', status: current.status };
}

export async function appendWorkSessionInput(
  workspaceId: string,
  workSessionId: string,
  input: string,
  options: { uploadedById?: string; attachments?: PreparedWorkAttachment[] } = {},
): Promise<WorkSessionTransitionResult> {
  const text = input.trim();
  if (!text || text.length > 20_000) return { ok: false, reason: 'invalid_input' };

  return db.$transaction(async (tx) => {
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: { conversationId: true, status: true },
    });
    if (!work) return { ok: false, reason: 'not_found' } as const;
    if (!['idle', 'waiting_user', 'completed', 'failed'].includes(work.status)) {
      return { ok: false, reason: 'invalid_transition', status: work.status } as const;
    }

    const updated = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: work.status,
      },
      data: {
        status: 'queued',
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
        ...(work.status === 'waiting_user' ? {} : { stepCount: 0, deadlineAt: null }),
      },
    });
    if (updated.count !== 1) {
      return { ok: false, reason: 'invalid_transition', status: work.status } as const;
    }
    const attachments = options.attachments ?? [];
    if (attachments.length) {
      if (!options.uploadedById) return { ok: false, reason: 'invalid_input' } as const;
      await claimWorkAttachments(tx, {
        workspaceId,
        userId: options.uploadedById,
        conversationId: work.conversationId,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: work.conversationId,
        role: 'user',
        parts: workMessageParts(text, attachments),
        textCharacters: text.length,
      },
    });
    return { ok: true, changed: true, status: 'queued' } as const;
  });
}

export async function listWorkSessions(workspaceId: string, agentId?: string) {
  return db.workSession.findMany({
    where: { workspaceId, status: { not: 'archived' }, ...(agentId ? { agentId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: workSessionSummaryInclude,
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
    include: workSessionClientInclude,
  });
}

export async function getWorkSessionForUser(userId: string, workSessionId: string) {
  return db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    },
    include: workSessionClientInclude,
  });
}

export async function archiveWorkSession(workspaceId: string, workSessionId: string) {
  const result = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId, status: { in: ['idle', 'completed', 'failed', 'cancelled'] } },
    data: { status: 'archived' },
  });
  return result.count === 1;
}
