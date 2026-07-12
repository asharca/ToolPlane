import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { ensureHermesRuntimeReady } from '@/lib/agents/hermes/runtime';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_ATTACHMENT_BYTES = 10_000_000;

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

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart request.' }, { status: 400 });
  }
  const file = formData.get('file');
  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'A non-empty file is required.' }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: 'Attachment exceeds 10 MB.' }, { status: 413 });
  }

  const requestedConversationId = String(formData.get('conversationId') ?? '').trim();
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

  const filename = safeFilename(file.name);
  const relativePath = `attachments/${conversationId || 'inbox'}/${randomUUID()}-${filename}`;
  const content = Buffer.from(await file.arrayBuffer()).toString('base64');
  const upstream = await fetch(`http://127.0.0.1:${ready.port}/files/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relativePath, content }),
    signal: AbortSignal.timeout(60_000),
    cache: 'no-store',
  });
  const result = await upstream.json().catch(() => ({})) as { path?: string; error?: string };
  if (!upstream.ok || !result.path) {
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
      name: file.name.slice(0, 240) || filename,
      mimeType: file.type.slice(0, 120) || 'application/octet-stream',
      size: file.size,
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
