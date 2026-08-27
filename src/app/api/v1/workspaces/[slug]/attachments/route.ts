import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import {
  formatAttachmentByteLimit,
  maxAgentAttachmentBytes,
} from '@/lib/agents/attachment-limits';
import {
  AttachmentStorageError,
  AttachmentTooLargeError,
  EmptyAttachmentError,
  deleteWorkspaceAttachmentFile,
  writeWorkspaceAttachment,
} from '@/lib/attachments/storage';

export const runtime = 'nodejs';
export const maxDuration = 900;

function requestMimeType(req: Request): string {
  const value = req.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
    ? value.slice(0, 120)
    : 'application/octet-stream';
}

function announcedContentLength(req: Request): number | null {
  const value = req.headers.get('content-length');
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug: workspaceId } = await params;
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    select: { id: true },
  });
  if (!workspace) return Response.json({ error: 'Workspace not found' }, { status: 404 });
  if (req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
    return Response.json(
      { error: 'Multipart attachment uploads are not supported; send the raw file body.' },
      { status: 415 },
    );
  }

  const filename = new URL(req.url).searchParams.get('filename')?.trim() ?? '';
  const announcedSize = announcedContentLength(req);
  if (!filename || filename.length > 240 || !req.body || Number.isNaN(announcedSize)) {
    return Response.json({ error: 'A valid filename and non-empty raw file body are required.' }, { status: 400 });
  }
  const maxBytes = await maxAgentAttachmentBytes();
  if (announcedSize !== null && announcedSize > maxBytes) {
    return Response.json(
      { error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.` },
      { status: 413 },
    );
  }

  let stored: { storagePath: string; size: number };
  try {
    stored = await writeWorkspaceAttachment({
      workspaceId: workspace.id,
      filename,
      body: req.body,
      maxBytes,
      signal: req.signal,
    });
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) {
      return Response.json(
        { error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.` },
        { status: 413 },
      );
    }
    if (error instanceof EmptyAttachmentError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof AttachmentStorageError ? 'Attachment storage is unavailable.' : 'Attachment upload failed.' },
      { status: 502 },
    );
  }

  try {
    const attachment = await db.workspaceAttachment.create({
      data: {
        workspaceId: workspace.id,
        uploadedById: user.id,
        name: filename,
        mimeType: requestMimeType(req),
        size: stored.size,
        storagePath: stored.storagePath,
      },
    });
    return Response.json({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url: `/api/v1/attachments/${attachment.id}`,
    }, { status: 201 });
  } catch {
    await deleteWorkspaceAttachmentFile(workspace.id, stored.storagePath).catch(() => undefined);
    return Response.json({ error: 'Could not save attachment metadata.' }, { status: 500 });
  }
}
