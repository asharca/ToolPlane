import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { captureConnectorScreen } from '@/lib/sandboxes/connector-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; sandboxId: string }> },
) {
  const { slug, sandboxId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const displayId = new URL(req.url).searchParams.get('displayId')?.trim() ?? '';
  if (!displayId || displayId.length > 128) {
    return NextResponse.json({ error: 'invalid display id' }, { status: 400 });
  }
  const sandbox = await db.sandbox.findFirst({
    where: {
      id: sandboxId,
      kind: 'connector',
      workspace: {
        slug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true },
  });
  if (!sandbox) return NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    const frame = await captureConnectorScreen(sandbox.id, displayId);
    return new Response(new Uint8Array(frame.data).buffer, {
      headers: {
        'cache-control': 'private, no-store',
        'content-type': frame.contentType,
        'content-length': String(frame.data.byteLength),
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'screen unavailable' }, {
      status: 409,
      headers: { 'cache-control': 'private, no-store' },
    });
  }
}
