import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import {
  HermesProfileError,
  listHermesProfiles,
  supportsHermesProfileChat,
} from '@/lib/agents/hermes/profiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.runtime?.kind !== 'hermes') {
    return Response.json({ error: 'Hermes runtime is not configured.' }, { status: 409 });
  }
  try {
    const profiles = await listHermesProfiles(agent);
    const profileChatSupported = await supportsHermesProfileChat(agent);
    return Response.json({ profiles, profileChatSupported });
  } catch (error) {
    if (error instanceof HermesProfileError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'Hermes profiles are unavailable.' }, { status: 502 });
  }
}
