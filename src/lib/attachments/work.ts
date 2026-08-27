import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { sandboxVolumeName } from '@/lib/sandboxes/runtime';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from '@/lib/agents/hermes/runtime';
import {
  copyWorkspaceAttachmentToDockerVolume,
  safeAttachmentFilename,
} from './storage';

const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export class WorkAttachmentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'WorkAttachmentError';
  }
}

export type PreparedWorkAttachment = {
  id: string;
  name: string;
  mimeType: string;
  runtimePath: string;
};

function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new WorkAttachmentError(400, `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed.`);
  }
  const ids = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new WorkAttachmentError(400, 'Invalid attachmentIds.');
  }
  return ids;
}

function destinationPath(workingDirectory: string, id: string, name: string): string {
  const prefix = workingDirectory === '.' ? '' : `${workingDirectory.replace(/\/+$/, '')}/`;
  return `${prefix}.toolplane/attachments/${id}/${safeAttachmentFilename(name)}`;
}

export async function prepareWorkAttachments(input: {
  workspaceId: string;
  userId: string;
  sandboxId: string;
  workingDirectory: string;
  attachmentIds: unknown;
  conversationId?: string;
}): Promise<PreparedWorkAttachment[]> {
  const ids = attachmentIds(input.attachmentIds);
  if (!ids.length) return [];

  const [sandbox, records] = await Promise.all([
    db.sandbox.findFirst({
      where: { id: input.sandboxId, workspaceId: input.workspaceId },
      select: {
        id: true,
        kind: true,
        agentRuntime: { select: { agentId: true } },
        deployment: { select: { installCfg: true } },
      },
    }),
    db.workspaceAttachment.findMany({
      where: {
        id: { in: ids },
        workspaceId: input.workspaceId,
        uploadedById: input.userId,
        chatThreadId: null,
        OR: [
          { conversationId: null },
          ...(input.conversationId ? [{ conversationId: input.conversationId }] : []),
        ],
      },
      select: { id: true, name: true, mimeType: true, storagePath: true },
    }),
  ]);
  if (!sandbox) throw new WorkAttachmentError(404, 'Sandbox not found.');
  if (sandbox.kind !== 'docker' && sandbox.kind !== 'hermes') {
    throw new WorkAttachmentError(400, 'Work attachments require a Docker-backed sandbox.');
  }
  if (sandbox.kind === 'hermes' && !sandbox.agentRuntime) {
    throw new WorkAttachmentError(409, 'Hermes runtime sandbox is not attached to an Agent.');
  }
  if (records.length !== ids.length) {
    throw new WorkAttachmentError(409, 'One or more attachments are unavailable or already in use.');
  }

  const config = (sandbox.deployment.installCfg ?? {}) as { volumeName?: unknown };
  const volumeName = typeof config.volumeName === 'string' && config.volumeName
    ? config.volumeName
    : sandboxVolumeName(sandbox.id);
  const byId = new Map(records.map((record) => [record.id, record]));
  const prepared: PreparedWorkAttachment[] = [];
  const writeLease = sandbox.agentRuntime
    ? acquireHermesRuntimeWriteLease(input.workspaceId, sandbox.agentRuntime.agentId)
    : undefined;
  if (sandbox.agentRuntime && !writeLease) {
    throw new WorkAttachmentError(503, HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR);
  }
  try {
    for (const id of ids) {
      const record = byId.get(id)!;
      const path = destinationPath(input.workingDirectory, record.id, record.name);
      await copyWorkspaceAttachmentToDockerVolume({
        workspaceId: input.workspaceId,
        storagePath: record.storagePath,
        destinationVolume: volumeName,
        destinationPath: sandbox.kind === 'hermes' ? `workspace/${path}` : path,
      });
      prepared.push({
        id: record.id,
        name: record.name,
        mimeType: record.mimeType,
        runtimePath: sandbox.kind === 'hermes' ? `/opt/data/workspace/${path}` : `/workspace/${path}`,
      });
    }
  } finally {
    writeLease?.release();
  }
  return prepared;
}

export async function claimWorkAttachments(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    attachments: PreparedWorkAttachment[];
  },
): Promise<void> {
  for (const attachment of input.attachments) {
    const claimed = await tx.workspaceAttachment.updateMany({
      where: {
        id: attachment.id,
        workspaceId: input.workspaceId,
        uploadedById: input.userId,
        chatThreadId: null,
        OR: [{ conversationId: null }, { conversationId: input.conversationId }],
      },
      data: { conversationId: input.conversationId },
    });
    if (claimed.count !== 1) {
      throw new WorkAttachmentError(409, 'An attachment was claimed by another conversation.');
    }
  }
}

export function workMessageParts(text: string, attachments: PreparedWorkAttachment[]) {
  return [
    { type: 'text', text },
    ...attachments.map((attachment) => ({
      type: 'file',
      mediaType: attachment.mimeType,
      filename: attachment.name,
      url: `/api/v1/attachments/${attachment.id}`,
      providerMetadata: { toolplane: { runtimePath: attachment.runtimePath } },
    })),
  ];
}
