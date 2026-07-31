import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { ensureHermesRuntimeReady } from '@/lib/agents/hermes/runtime';
import {
  formatAttachmentByteLimit,
  maxAgentAttachmentBytes,
} from '@/lib/agents/attachment-limits';

export const runtime = 'nodejs';
export const maxDuration = 900;

function safeFilename(value: string): string {
  const clean = value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return clean || 'attachment';
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  if (!agent.runtime || agent.runtime.kind !== 'hermes') {
    return NextResponse.json({ error: 'Attachment storage requires a Hermes runtime.' }, { status: 400 });
  }

  const requestUrl = new URL(req.url);
  if (req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Multipart attachment uploads are not supported; send the raw file body.' },
      { status: 415 },
    );
  }
  const filename = requestUrl.searchParams.get('filename')?.trim() ?? '';
  const mimeType = req.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
  const body: BodyInit | null = req.body;
  const announcedSize = Number(req.headers.get('content-length') ?? 0);
  const requestedConversationId = requestUrl.searchParams.get('conversationId')?.trim() ?? '';

  if (!filename || !body || announcedSize < 0) {
    return NextResponse.json({ error: 'A non-empty file and filename are required.' }, { status: 400 });
  }
  const maxBytes = await maxAgentAttachmentBytes();
  if (announcedSize > maxBytes) {
    return NextResponse.json(
      { error: `Attachment exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.` },
      { status: 413 },
    );
  }

  const conversationId = requestedConversationId
    ? (await db.conversation.findFirst({
        where: { id: requestedConversationId, agentId: agent.id },
        select: { id: true },
      }))?.id
    : undefined;
  if (requestedConversationId && !conversationId) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  const ready = await ensureHermesRuntimeReady(agent.workspaceId, agent.id);
  if (!ready.port) {
    return NextResponse.json({ error: ready.error || 'Hermes runtime is unavailable.' }, { status: 503 });
  }

  const storageFilename = safeFilename(filename);
  const relativePath = `attachments/${conversationId || 'inbox'}/${randomUUID()}-${storageFilename}`;
  const upstreamUrl = new URL(`http://127.0.0.1:${ready.port}/files/upload`);
  upstreamUrl.searchParams.set('path', relativePath);
  let upstream: Response;
  try {
    const uploadInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-toolplane-max-upload-bytes': String(maxBytes),
      },
      body,
      duplex: 'half',
      signal: AbortSignal.timeout(15 * 60_000),
      cache: 'no-store',
    };
    upstream = await fetch(upstreamUrl, uploadInit);
  } catch (error) {
    const detail = error instanceof Error && error.name === 'TimeoutError'
      ? 'Attachment upload timed out.'
      : 'Could not reach the Hermes attachment store.';
    return NextResponse.json({ error: detail }, { status: 502 });
  }
  const result = await upstream.json().catch(() => ({})) as {
    path?: string;
    size?: number;
    error?: string;
  };
  if (!upstream.ok || !result.path || !Number.isSafeInteger(result.size) || Number(result.size) <= 0) {
    return NextResponse.json(
      { error: result.error || 'Could not store attachment in the Hermes workspace.' },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    );
  }

  const attachment = await db.agentAttachment.create({
    data: {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      conversationId: conversationId ?? null,
      runtimeId: agent.runtime.id,
      name: filename.slice(0, 240) || storageFilename,
      mimeType: mimeType.slice(0, 120),
      size: Number(result.size),
      storage: 'hermes-volume',
      storagePath: result.path,
    },
  });

  return NextResponse.json({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    runtimePath: attachment.storagePath,
  }, { status: 201 });
}
