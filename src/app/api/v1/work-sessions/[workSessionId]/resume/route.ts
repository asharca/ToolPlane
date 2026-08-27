import { resolveRequestUser } from '@/lib/auth/request-user';
import { getWorkSessionForUser, resumeWorkSession } from '@/lib/work/sessions';
import { kickWorkCoordinator } from '@/lib/work/coordinator';
import { startWorkOutput } from '@/lib/work/run-control';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workSessionId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { workSessionId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work) return Response.json({ error: 'Not found' }, { status: 404 });
  const result = await resumeWorkSession(work.workspaceId, work.id);
  if (!result.ok) {
    return Response.json(
      { error: result.reason === 'invalid_transition' ? `Cannot resume ${result.status} work` : 'Not found' },
      { status: result.reason === 'not_found' ? 404 : 409 },
    );
  }
  startWorkOutput(work.id);
  kickWorkCoordinator();
  return Response.json({ status: result.status }, { status: 202 });
}
