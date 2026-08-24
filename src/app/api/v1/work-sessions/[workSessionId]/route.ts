import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';

export async function DELETE(req: Request, { params }: { params: Promise<{ workSessionId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { workSessionId } = await params;
  const updated = await db.workSession.updateMany({
    where: {
      id: workSessionId,
      workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
    },
    data: { status: 'archived' },
  });
  return updated.count ? new Response(null, { status: 204 }) : Response.json({ error: 'Not found' }, { status: 404 });
}
