import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { connectorFromConfig } from '@/lib/sandboxes/connector';
import { createConnectorScreenSession } from '@/lib/sandboxes/connector-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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

  const body = await req.json().catch(() => null) as { displayId?: unknown } | null;
  const displayId = typeof body?.displayId === 'string' ? body.displayId.trim() : '';
  if (!displayId || displayId.length > 128) {
    return NextResponse.json({ error: 'invalid display id' }, { status: 400 });
  }
  const connector = connectorFromConfig(sandbox.config);
  if (!connector) return NextResponse.json({ error: 'connector is not configured' }, { status: 409 });

  try {
    const session = await createConnectorScreenSession(sandbox.id, displayId, connector.serverUrl);
    return NextResponse.json(session, {
      status: 201,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'screen unavailable' }, {
      status: 409,
      headers: { 'cache-control': 'private, no-store' },
    });
  }
}
