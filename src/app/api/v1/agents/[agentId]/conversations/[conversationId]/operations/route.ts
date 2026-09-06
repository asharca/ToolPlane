import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { ConversationOperationError, operateConversation } from '@/lib/agents/conversation-operations';
import { executeRuntimeCommand, RuntimeCommandError } from '@/lib/agents/runtime-command-service';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';

export const runtime = 'nodejs';
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ agentId: string; conversationId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { agentId, conversationId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'notFound' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || !['new', 'compact'].includes(body.action)
    || (body.instructions !== undefined && (typeof body.instructions !== 'string' || body.instructions.length > 2000))) {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    if (body.action === 'compact' && isDedicatedSandboxRuntimeKind(agent.runtimeKind)) return Response.json(await executeRuntimeCommand({ workspaceId: agent.workspaceId, agentId, conversationId,
      line: `/compact${body.instructions ? ` ${body.instructions}` : ''}`, signal: req.signal }));
    return Response.json(await operateConversation({ workspaceId: agent.workspaceId, agentId, conversationId,
      action: body.action, instructions: body.instructions, signal: req.signal }));
  } catch (error) {
    if (error instanceof RuntimeCommandError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ConversationOperationError) return Response.json({ error: error.code }, { status: error.status });
    console.error('[conversation] operation failed', error);
    return Response.json({ error: 'failed' }, { status: 502 });
  }
}
