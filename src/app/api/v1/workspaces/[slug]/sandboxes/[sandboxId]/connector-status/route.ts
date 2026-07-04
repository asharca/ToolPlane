import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { connectorStatus } from '@/lib/sandboxes/connector-broker';
import { connectorFromConfig } from '@/lib/sandboxes/connector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; sandboxId: string }> },
) {
  const { slug, sandboxId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sandbox = await db.sandbox.findFirst({
    where: {
      id: sandboxId,
      kind: 'connector',
      workspace: {
        slug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true, config: true },
  });
  if (!sandbox) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const connector = connectorFromConfig(sandbox.config);
  const status = connectorStatus(sandbox.id);
  return NextResponse.json({
    ...status,
    configured: Boolean(connector),
    expectedRoot: connector?.remoteRoot ?? null,
  });
}
