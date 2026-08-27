import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getWorkSessionForUser } from '@/lib/work/sessions';
import { isWorkRunActive } from '@/lib/work/run-control';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workSessionId: string; approvalId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (body.decision !== 'allow' && body.decision !== 'deny') {
    return Response.json({ error: 'decision must be allow or deny' }, { status: 400 });
  }

  const { workSessionId, approvalId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work || !work.approvals.some((approval) => approval.id === approvalId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  if (work.status !== 'waiting_approval') {
    return Response.json({ error: `Cannot approve ${work.status} work` }, { status: 409 });
  }
  const status = body.decision === 'allow' ? 'allowed' : 'denied';
  const updated = await db.workApproval.updateMany({
    where: {
      id: approvalId,
      workSessionId,
      status: 'pending',
      workSession: { status: 'waiting_approval' },
    },
    data: { status, resolvedById: user.id, resolvedAt: new Date() },
  });
  if (!updated.count) return Response.json({ error: 'Approval already resolved' }, { status: 409 });

  if (!isWorkRunActive(workSessionId)) {
    await db.workSession.updateMany({
      where: { id: workSessionId, status: 'waiting_approval' },
      data: {
        status: 'failed',
        error: 'The server restarted while approval was pending. Review the decision, then resume the work.',
        completedAt: new Date(),
      },
    });
  }
  return Response.json({ status });
}
