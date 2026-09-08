import { systemLog } from '@/lib/observability/system';
import { withRequestLogging } from '@/lib/observability/http';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { ConversationOperationError } from '@/lib/agents/conversation-operations';
import { executeRuntimeCommand, RuntimeCommandError } from '@/lib/agents/runtime-command-service';
export const runtime = 'nodejs';
export const maxDuration = 900;

export const POST = withRequestLogging("/api/v1/agents/[agentId]/conversations/[conversationId]/commands", async function POST(req: Request, { params }: { params: Promise<{ agentId: string; conversationId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { agentId, conversationId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'notFound' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.line !== 'string' || body.line.length > 2000 || Object.keys(body).some((key) => key !== 'line')) return Response.json({ error: 'invalidCommand' }, { status: 400 });
  try {
    return Response.json(await executeRuntimeCommand({ workspaceId: agent.workspaceId, agentId, conversationId, line: body.line, signal: req.signal }));
  } catch (error) {
    if (error instanceof RuntimeCommandError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ConversationOperationError) return Response.json({ error: error.code }, { status: error.status });
    systemLog('error', '[runtime-command] failed', error);
    return Response.json({ error: 'failed' }, { status: 502 });
  }
});
