import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { livePort, effectiveStatus } from '@/lib/process/supervisor';
import { logRequest } from '@/lib/observability/log';

// Gateway health proxy: forwards to the live stub process for a deployment
// and records the request for observability.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const start = Date.now();
  const { deploymentId } = await params;
  const user = await getCurrentUser();
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
    select: { id: true, status: true, workspaceId: true },
  });
  if (!dep) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const port = livePort(deploymentId);
  const status = effectiveStatus(deploymentId, dep.status);
  let statusCode = 200;
  let payload: Record<string, unknown> = { status, reachable: false };

  if (!port) {
    statusCode = 503;
  } else {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      payload = { status, reachable: true, upstream: await res.json() };
    } catch {
      statusCode = 502;
    }
  }

  await logRequest({
    workspaceId: dep.workspaceId,
    deploymentId,
    method: 'GET',
    path: `/mcp/${deploymentId}/health`,
    statusCode,
    durationMs: Date.now() - start,
  });

  return NextResponse.json(payload, { status: statusCode });
}
