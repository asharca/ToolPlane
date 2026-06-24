import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { livePort, liveStatus } from '@/lib/process/supervisor';

// Gateway health proxy: forwards to the live stub process for a deployment,
// proving the supervised process is actually reachable.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
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
    select: { id: true, status: true },
  });
  if (!dep) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const port = livePort(deploymentId);
  const status = liveStatus(deploymentId) ?? dep.status;
  if (!port) {
    return NextResponse.json({ status, reachable: false });
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = await res.json();
    return NextResponse.json({ status, reachable: true, upstream: body });
  } catch {
    return NextResponse.json({ status, reachable: false });
  }
}
