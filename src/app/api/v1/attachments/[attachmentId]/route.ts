import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import {
  deleteWorkspaceAttachmentFile,
  readWorkspaceAttachment,
} from '@/lib/attachments/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ attachmentId: string }>;

async function authorizedAttachment(req: Request, attachmentId: string) {
  const user = await resolveRequestUser(req);
  if (!user) return { user: null, attachment: null };
  const attachment = await db.workspaceAttachment.findFirst({
    where: {
      id: attachmentId,
      workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
    },
    select: {
      id: true,
      workspaceId: true,
      uploadedById: true,
      chatThreadId: true,
      conversationId: true,
      name: true,
      mimeType: true,
      size: true,
      storagePath: true,
    },
  });
  if (attachment && !attachment.chatThreadId && !attachment.conversationId && attachment.uploadedById !== user.id) {
    return { user, attachment: null };
  }
  return { user, attachment };
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_').slice(0, 160) || 'attachment';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request, { params }: { params: Params }) {
  const { attachmentId } = await params;
  const { user, attachment } = await authorizedAttachment(req, attachmentId);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!attachment) return Response.json({ error: 'Attachment not found' }, { status: 404 });
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0) {
    return Response.json({ error: 'Attachment metadata is invalid' }, { status: 500 });
  }

  try {
    const body = readWorkspaceAttachment(attachment.workspaceId, attachment.storagePath, attachment.size);
    return new Response(body, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': contentDisposition(attachment.name),
        'content-length': String(attachment.size),
        'content-type': attachment.mimeType,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return Response.json({ error: 'Attachment storage is unavailable' }, { status: 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { attachmentId } = await params;
  const { user, attachment } = await authorizedAttachment(req, attachmentId);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!attachment) return Response.json({ error: 'Attachment not found' }, { status: 404 });
  if (attachment.uploadedById !== user.id) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }
  if (attachment.chatThreadId || attachment.conversationId) {
    return Response.json({ error: 'Attachment is in use' }, { status: 409 });
  }

  const deleted = await db.workspaceAttachment.deleteMany({
    where: {
      id: attachment.id,
      workspaceId: attachment.workspaceId,
      uploadedById: user.id,
      chatThreadId: null,
      conversationId: null,
    },
  });
  if (!deleted.count) return Response.json({ error: 'Attachment is in use' }, { status: 409 });

  try {
    await deleteWorkspaceAttachmentFile(attachment.workspaceId, attachment.storagePath);
  } catch (error) {
    console.error('[workspace-attachment] file cleanup failed', {
      attachmentId: attachment.id,
      workspaceId: attachment.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return new Response(null, { status: 204 });
}
