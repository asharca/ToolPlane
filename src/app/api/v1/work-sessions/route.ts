import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { createWorkSession, listWorkSessions } from '@/lib/work/sessions';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const agentId = new URL(req.url).searchParams.get('agentId')?.trim();
  if (!agentId) return Response.json({ error: 'agentId is required' }, { status: 400 });
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  return Response.json(await listWorkSessions(agent.workspaceId, agent.id));
}

export async function POST(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { agentId?: unknown; sandboxId?: unknown; task?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
    return Response.json({ error: 'agentId is required' }, { status: 400 });
  }
  if (body.sandboxId !== undefined && typeof body.sandboxId !== 'string') {
    return Response.json({ error: 'Invalid sandboxId' }, { status: 400 });
  }
  if (body.task !== undefined && (typeof body.task !== 'string' || body.task.length > 20_000)) {
    return Response.json({ error: 'Invalid task' }, { status: 400 });
  }
  const agent = await getAgentForRequest(body.agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  const work = await createWorkSession({
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    sandboxId: body.sandboxId,
    task: body.task,
  });
  if (!work) return Response.json({ error: 'Choose an Agent sandbox first' }, { status: 400 });
  return Response.json({ workSessionId: work.id, conversationId: work.conversationId });
}
