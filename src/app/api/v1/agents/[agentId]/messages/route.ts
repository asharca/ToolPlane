import { withRequestLogging } from '@/lib/observability/http';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { runAgentMessage } from '@/lib/agents/message-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withRequestLogging("/api/v1/agents/[agentId]/messages", async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const result = await runAgentMessage({ agentId, userId: user.id, rawBody });
  return Response.json(result.body, { status: result.status });
});
