import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveRequestPrincipal } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { isSameOriginRequest } from '@/lib/http/origin';
import { withRequestLogging } from '@/lib/observability/http';
import { collaborationJson, collaborationHttpError, readCollaborationJson } from '@/lib/agents/collaboration/http';
import { CollaborationError, Id, Prompt, RequestId } from '@/lib/agents/collaboration/protocol';
import { listDelegations, getDelegation, cancelDelegation, continueDelegation, decideDelegation } from '@/lib/agents/collaboration/service';
export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = { params: Promise<{ slug: string; agentId: string }> };
async function principal(req: Request, context: Context) {
  const user = await resolveRequestPrincipal(req);
  if (!user || user.credential === 'toolkit-token') throw new CollaborationError('unauthorized', 'Authentication required.', 401);
  if (req.method !== 'GET' && ((user.credential === 'session' || req.headers.has('origin')) && !isSameOriginRequest(req))) {
    throw new CollaborationError('origin', 'Same-origin request required.', 403);
  }
  const { slug, agentId } = await context.params;
  const ws = await getWorkspaceForUser(slug, user.user.id);
  if (!ws || !await db.agent.count({ where: { id: agentId, workspaceId: ws.id, publicRuntimeAllocation: null } })) throw new CollaborationError('not_found', 'Agent not found.', 404);
  return { kind: 'user' as const, workspaceId: ws.id, agentId, userId: user.user.id };
}
export const GET = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/collaboration', async (req: Request, context: Context) => {
  try {
    const actor = await principal(req, context);
    const url = new URL(req.url);
    const taskId = url.searchParams.get('taskId');
    return collaborationJson(taskId ? { task: await getDelegation(actor, Id.parse(taskId)) }
      : { tasks: await listDelegations(actor), limit: 50 });
  } catch (error) { return collaborationHttpError(error); }
});
const Action = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['approve', 'reject', 'cancel']), taskId: Id }).strict(),
  z.object({ action: z.literal('continue'), taskId: Id, messageId: RequestId, message: Prompt }).strict(),
]);
export const POST = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/collaboration', async (req: Request, context: Context) => {
  try {
    const actor = await principal(req, context);
    const parsed = Action.safeParse(await readCollaborationJson(req));
    if (!parsed.success) throw new CollaborationError('invalid_arguments', 'Invalid collaboration action.');
    const input = parsed.data;
    const task = input.action === 'continue' ? await continueDelegation(actor, input)
      : input.action === 'cancel' ? await cancelDelegation(actor, input.taskId)
        : await decideDelegation(actor, input.taskId, input.action === 'approve');
    return collaborationJson({ task });
  } catch (error) { return collaborationHttpError(error); }
});
