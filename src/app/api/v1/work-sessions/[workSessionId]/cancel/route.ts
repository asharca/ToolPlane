import { resolveRequestUser } from '@/lib/auth/request-user';
import {
  cancelWorkSession,
  finalizeWorkSessionCancellation,
  getWorkSessionForUser,
} from '@/lib/work/sessions';
import { abortWorkRun, finishWorkOutput } from '@/lib/work/run-control';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workSessionId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { workSessionId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work) return Response.json({ error: 'Not found' }, { status: 404 });

  const result = await cancelWorkSession(work.workspaceId, work.id);
  if (!result.ok) {
    return Response.json(
      { error: result.reason === 'invalid_transition' ? `Cannot cancel ${result.status} work` : 'Not found' },
      { status: result.reason === 'not_found' ? 404 : 409 },
    );
  }
  const active = abortWorkRun(work.id);
  if (result.status === 'cancelling' && !active) {
    await finalizeWorkSessionCancellation(work.workspaceId, work.id);
    finishWorkOutput(work.id);
    return Response.json({ status: 'idle' });
  }
  if (!active) finishWorkOutput(work.id);
  return Response.json({ status: result.status });
}
