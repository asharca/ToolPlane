import 'server-only';
import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { livePort } from '@/lib/process/supervisor';

export async function resolveLiveDeployment(req: Request, deploymentId: string) {
  const user = await resolveRequestUser(req);
  if (!user) {
    return { response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }

  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true, workspaceId: true },
  });
  if (!dep) {
    return { response: NextResponse.json({ error: 'not found' }, { status: 404 }) };
  }

  const port = livePort(deploymentId);
  if (!port) {
    return { response: NextResponse.json({ error: 'deployment not running' }, { status: 503 }) };
  }

  return { dep, port };
}
