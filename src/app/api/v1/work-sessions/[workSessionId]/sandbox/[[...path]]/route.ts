import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { livePort } from '@/lib/process/supervisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1_000_000;
type Params = Promise<{ workSessionId: string; path?: string[] }>;

async function resolveTarget(req: Request, workSessionId: string) {
  const user = await resolveRequestUser(req);
  if (!user) return null;
  const work = await db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
      sandboxId: { not: null },
    },
    select: {
      sandboxId: true,
      agent: { select: { sandboxes: { select: { sandboxId: true } } } },
      sandbox: { select: { deploymentId: true } },
    },
  });
  if (!work?.sandbox || !work.sandboxId || !work.agent.sandboxes.some((link) => link.sandboxId === work.sandboxId)) return null;
  const port = livePort(work.sandbox.deploymentId);
  return port ? { port } : null;
}

function upstreamPath(path: string[]) {
  if (path[0] === 'rpc' && path.length === 1) return '/';
  if (path[0] === 'terminal') return `/${path.map(encodeURIComponent).join('/')}`;
  return null;
}

async function proxy(req: Request, params: Params) {
  const { workSessionId, path = [] } = await params;
  const targetPath = upstreamPath(path);
  if (!targetPath) return Response.json({ error: 'Not found' }, { status: 404 });
  const target = await resolveTarget(req, workSessionId);
  if (!target) return Response.json({ error: 'Work sandbox is unavailable' }, { status: 404 });
  const body = ['GET', 'DELETE'].includes(req.method) ? undefined : await req.text();
  if (body && Buffer.byteLength(body) > MAX_BODY) return Response.json({ error: 'Request too large' }, { status: 413 });
  try {
    const stream = req.method === 'GET' && path.at(-1) === 'stream';
    const upstream = await fetch(`http://127.0.0.1:${target.port}${targetPath}`, {
      method: req.method,
      headers: {
        accept: req.headers.get('accept') ?? '*/*',
        ...(body !== undefined ? { 'content-type': req.headers.get('content-type') ?? 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: stream ? req.signal : AbortSignal.timeout(30_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        ...(stream ? { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } : {}),
      },
    });
  } catch {
    return Response.json({ error: 'Work sandbox is unreachable' }, { status: 502 });
  }
}

export async function GET(req: Request, { params }: { params: Params }) { return proxy(req, params); }
export async function POST(req: Request, { params }: { params: Params }) { return proxy(req, params); }
export async function DELETE(req: Request, { params }: { params: Params }) { return proxy(req, params); }
