import { z } from 'zod';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { listComposerItems, resolveComposerReference, ComposerRequestError } from '@/lib/work/composer';
import { McpPromptRequestError } from '@/lib/process/mcp-prompts';

export const runtime = 'nodejs';
type Params = { params: Promise<{ agentId: string }> };
const scope = { sandboxId: z.string().min(1).max(240).optional(), workSessionId: z.string().min(1).max(240).optional() };
const ListSchema = z.object({ ...scope, section: z.enum(['references', 'skills', 'resources']), query: z.string().max(200).default(''), excludeConversationId: z.string().max(240).optional() }).strict();
const ResolveSchema = z.object({ ...scope, kind: z.enum(['file', 'session', 'skill', 'resource']), id: z.string().min(1).max(4000), deploymentId: z.string().min(1).max(240).optional() }).strict();

async function handle(req: Request, { params }: Params) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const agent = await getAgentForRequest((await params).agentId, user.id);
  if (!agent) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    if (req.method === 'GET') {
      const input = ListSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!input.success) return Response.json({ error: 'Invalid composer request' }, { status: 400 });
      return Response.json(await listComposerItems(agent, input.data, req.signal));
    }
    const input = ResolveSchema.safeParse(await req.json().catch(() => null));
    if (!input.success) return Response.json({ error: 'Invalid reference' }, { status: 400 });
    return Response.json(await resolveComposerReference(agent, input.data, req.signal));
  } catch (error) {
    if (error instanceof ComposerRequestError || error instanceof McpPromptRequestError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Composer resource is unavailable.' }, { status: 502 });
  }
}
export const GET = handle;
export const POST = handle;
