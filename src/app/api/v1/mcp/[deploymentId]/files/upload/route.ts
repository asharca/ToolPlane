import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import {
  formatAttachmentByteLimit,
  maxAgentAttachmentBytes,
} from '@/lib/agents/attachment-limits';
import { livePort } from '@/lib/process/supervisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

function safeUploadPath(value: string | null): string | null {
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return null;
  if (Buffer.byteLength(value, 'utf8') > 1_000 || /[\0-\x1f\x7f]/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || Buffer.byteLength(segment, 'utf8') > 255
  ))) return null;
  return value;
}

function contentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await params;
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      sandbox: { isNot: null },
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true },
  });
  if (!deployment) return Response.json({ error: 'Sandbox not found' }, { status: 404 });

  const port = livePort(deployment.id);
  if (!port) return Response.json({ error: 'Sandbox is not running' }, { status: 503 });
  if (req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
    return Response.json({ error: 'Send the raw file body.' }, { status: 415 });
  }

  const path = safeUploadPath(new URL(req.url).searchParams.get('path'));
  const announcedSize = contentLength(req);
  if (!path || !req.body || Number.isNaN(announcedSize) || announcedSize === 0) {
    return Response.json({ error: 'A safe path and non-empty file are required.' }, { status: 400 });
  }
  const maxBytes = await maxAgentAttachmentBytes();
  if (announcedSize !== null && announcedSize > maxBytes) {
    return Response.json(
      { error: `File exceeds the ${formatAttachmentByteLimit(maxBytes)} limit.` },
      { status: 413 },
    );
  }

  const upstreamUrl = new URL(`http://127.0.0.1:${port}/files/upload`);
  upstreamUrl.searchParams.set('path', path);
  try {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-toolplane-max-upload-bytes': String(maxBytes),
        ...(announcedSize !== null ? { 'content-length': String(announcedSize) } : {}),
      },
      body: req.body,
      duplex: 'half',
      cache: 'no-store',
      signal: AbortSignal.timeout(15 * 60_000),
    };
    const upstream = await fetch(upstreamUrl, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error && error.name === 'TimeoutError'
        ? 'File upload timed out.'
        : 'Sandbox file storage is unreachable.',
    }, { status: 502 });
  }
}
