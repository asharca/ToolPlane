import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { livePort } from '@/lib/process/supervisor';
import { logRequest } from '@/lib/observability/log';

// Gateway: proxy a real MCP JSON-RPC request to the live deployment process
// and record it for observability. POST a JSON-RPC 2.0 envelope, e.g.
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const start = Date.now();
  const { deploymentId } = await params;

  const user = await resolveRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!dep) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = await req.text();
  let rpcMethod = '';
  try {
    rpcMethod = String(JSON.parse(body || '{}')?.method ?? '');
  } catch {
    // logged path falls back to the bare rpc path
  }

  const port = livePort(deploymentId);
  let statusCode = 200;
  let payload: unknown = { error: 'deployment not running' };

  if (!port) {
    statusCode = 503;
  } else {
    try {
      const upstream = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body || '{}',
        signal: AbortSignal.timeout(3000),
      });
      statusCode = upstream.status;
      const text = await upstream.text();
      payload = text ? JSON.parse(text) : {};
    } catch {
      statusCode = 502;
      payload = { error: 'upstream unreachable' };
    }
  }

  await logRequest({
    workspaceId: dep.workspaceId,
    deploymentId,
    method: 'POST',
    path: `/mcp/${deploymentId}/rpc${rpcMethod ? `#${rpcMethod}` : ''}`,
    statusCode,
    durationMs: Date.now() - start,
  });

  return NextResponse.json(payload, { status: statusCode });
}
