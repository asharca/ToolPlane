import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { createConversation } from '@/lib/agents/mutations';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const user = await resolveRequestUser(_req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });

  const conversation = await createConversation(agent.workspaceId, agent.id);
  if (!conversation) return Response.json({ error: 'Conversation not found' }, { status: 404 });

  return Response.json({ conversationId: conversation.id });
}
