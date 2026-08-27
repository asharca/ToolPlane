import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { readWorkspaceAttachment } from './storage';

export const MAX_MESSAGE_ATTACHMENTS = 5;
const MAX_HYDRATED_BYTES = 20 * 1024 * 1024;
const MAX_HYDRATED_TEXT_CHARACTERS = 200_000;
const INTERNAL_ATTACHMENT_URL = /^\/api\/v1\/attachments\/([A-Za-z0-9_-]{1,128})$/;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'application/csv',
  'application/json',
  'application/markdown',
]);

type MessagePart = Record<string, unknown>;
type MessageLike = { role: string; parts: MessagePart[] };
type AttachmentScope = { chatThreadId: string } | { conversationId: string };

export class AttachmentMessageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AttachmentMessageError';
  }
}

function attachmentIdFromPart(part: unknown): string | null {
  if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'file') return null;
  const url = 'url' in part ? part.url : undefined;
  const match = typeof url === 'string' ? INTERNAL_ATTACHMENT_URL.exec(url) : null;
  if (!match) {
    throw new AttachmentMessageError(400, 'Attachment URLs must use the internal attachment endpoint.');
  }
  return match[1];
}

export function attachmentIdsFromParts(parts: readonly unknown[]): string[] {
  const ids: string[] = [];
  let fileParts = 0;
  for (const part of parts) {
    const id = attachmentIdFromPart(part);
    if (!id) continue;
    fileParts += 1;
    if (fileParts > MAX_MESSAGE_ATTACHMENTS) {
      throw new AttachmentMessageError(400, `A message can contain at most ${MAX_MESSAGE_ATTACHMENTS} attachments.`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function scopeQuery(scope: AttachmentScope): Prisma.WorkspaceAttachmentWhereInput {
  return 'chatThreadId' in scope
    ? { chatThreadId: scope.chatThreadId, conversationId: null }
    : { conversationId: scope.conversationId, chatThreadId: null };
}

export async function claimWorkspaceAttachments(
  tx: Prisma.TransactionClient,
  input: {
    ids: readonly string[];
    workspaceId: string;
    uploadedById: string;
    scope: AttachmentScope;
  },
): Promise<void> {
  for (const id of input.ids) {
    const claimed = await tx.workspaceAttachment.updateMany({
      where: {
        id,
        workspaceId: input.workspaceId,
        uploadedById: input.uploadedById,
        OR: [
          { chatThreadId: null, conversationId: null },
          scopeQuery(input.scope),
        ],
      },
      data: input.scope,
    });
    if (claimed.count) continue;

    const attachment = await tx.workspaceAttachment.findUnique({
      where: { id },
      select: {
        workspaceId: true,
        uploadedById: true,
        chatThreadId: true,
        conversationId: true,
      },
    });
    if (!attachment
      || attachment.workspaceId !== input.workspaceId
      || attachment.uploadedById !== input.uploadedById) {
      throw new AttachmentMessageError(400, 'One or more attachments do not belong to this request.');
    }
    const sameScope = 'chatThreadId' in input.scope
      ? attachment.chatThreadId === input.scope.chatThreadId && attachment.conversationId === null
      : attachment.conversationId === input.scope.conversationId && attachment.chatThreadId === null;
    if (!sameScope) {
      throw new AttachmentMessageError(409, 'One or more attachments already belong to another conversation.');
    }
  }
}

function validImageMagic(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a'
    || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function readAttachment(attachment: {
  workspaceId: string;
  storagePath: string;
  size: number;
}): Promise<Buffer> {
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0) {
    throw new AttachmentMessageError(500, 'Attachment metadata is invalid.');
  }
  try {
    const bytes = Buffer.from(await new Response(readWorkspaceAttachment(
      attachment.workspaceId,
      attachment.storagePath,
      attachment.size,
    )).arrayBuffer());
    if (bytes.byteLength !== attachment.size) {
      throw new AttachmentMessageError(502, 'Attachment storage returned incomplete data.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof AttachmentMessageError) throw error;
    throw new AttachmentMessageError(502, 'Attachment storage is unavailable.');
  }
}

export async function hydrateWorkspaceAttachmentMessages(
  messages: readonly MessageLike[],
  input: { workspaceId: string; scope: AttachmentScope },
): Promise<MessageLike[]> {
  const ids = [...new Set(messages.flatMap((message) => attachmentIdsFromParts(message.parts)))];
  if (!ids.length) return messages.map((message) => ({ ...message, parts: [...message.parts] }));

  const attachments = await db.workspaceAttachment.findMany({
    where: {
      id: { in: ids },
      workspaceId: input.workspaceId,
      ...scopeQuery(input.scope),
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      mimeType: true,
      size: true,
      storagePath: true,
    },
  });
  if (attachments.length !== ids.length) {
    throw new AttachmentMessageError(409, 'One or more attachments do not belong to this conversation.');
  }
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const reads = new Map<string, Promise<Buffer>>();
  let hydratedBytes = 0;
  let hydratedTextCharacters = 0;

  const hydrated: MessageLike[] = [];
  for (const message of messages) {
    const parts: MessagePart[] = [];
    for (const part of message.parts) {
      const id = attachmentIdFromPart(part);
      if (!id) {
        parts.push({ ...part });
        continue;
      }
      const attachment = byId.get(id)!;
      const mimeType = attachment.mimeType.toLowerCase();
      if (!IMAGE_MIME_TYPES.has(mimeType) && !TEXT_MIME_TYPES.has(mimeType) && !mimeType.endsWith('+json')) {
        throw new AttachmentMessageError(415, `Attachment type "${attachment.mimeType}" is not supported by this runtime.`);
      }
      hydratedBytes += attachment.size;
      if (hydratedBytes > MAX_HYDRATED_BYTES) {
        throw new AttachmentMessageError(413, 'Attachments exceed the 20 MB model input limit.');
      }
      let read = reads.get(id);
      if (!read) {
        read = readAttachment(attachment);
        reads.set(id, read);
      }
      const bytes = await read;

      if (IMAGE_MIME_TYPES.has(mimeType)) {
        if (!validImageMagic(mimeType, bytes)) {
          throw new AttachmentMessageError(415, `Attachment "${attachment.name}" does not match its image type.`);
        }
        parts.push(
          { type: 'text', text: `[Attached image: ${JSON.stringify(attachment.name)}]` },
          { type: 'image', data: bytes.toString('base64'), mimeType },
        );
        continue;
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new AttachmentMessageError(415, `Attachment "${attachment.name}" is not valid UTF-8 text.`);
      }
      hydratedTextCharacters += text.length;
      if (hydratedTextCharacters > MAX_HYDRATED_TEXT_CHARACTERS) {
        throw new AttachmentMessageError(413, 'Text attachments exceed the 200,000 character model input limit.');
      }
      parts.push({
        type: 'text',
        text: `[Begin attachment ${JSON.stringify(attachment.name)}]\n${text}\n[End attachment ${JSON.stringify(attachment.name)}]`,
      });
    }
    hydrated.push({ ...message, parts });
  }
  return hydrated;
}
