import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import {
  getDeploymentRuntimeLogChunk,
  getDeploymentRuntimeSnapshot,
} from '@/lib/process/supervisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LOG_BYTES = 64 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Runtime progress is intentionally separate from the RPC gateway: a deployment
// can be provisioning (and have useful stderr output) before it has a live port.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    },
    select: { id: true },
  });
  if (!deployment) {
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE });
  }

  const url = new URL(req.url);
  const generation = url.searchParams.get('generation');
  const cursor = nonNegativeInteger(url.searchParams.get('cursor'), 0);
  const requestedLimit = nonNegativeInteger(url.searchParams.get('limit'), 16 * 1024);
  const limit = Math.min(MAX_LOG_BYTES, Math.max(1, requestedLimit));

  const [snapshot, logs] = await Promise.all([
    getDeploymentRuntimeSnapshot(deploymentId),
    getDeploymentRuntimeLogChunk(deploymentId, {
      ...(generation ? { generation } : {}),
      cursor,
      limit,
    }),
  ]);

  return NextResponse.json(
    { snapshot, logs },
    { headers: NO_STORE },
  );
}
