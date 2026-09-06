import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';

export const runtime = 'nodejs';
type Params = { params: Promise<{ agentId: string }> };
const PromptSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: z.string().min(1).max(240).optional(), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().min(1).max(240) }).strict(),
]);

async function authorized(req: Request, params: Params['params']) {
  const user = await resolveRequestUser(req);
  return user ? getAgentForRequest((await params).agentId, user.id) : null;
}

export async function GET(req: Request, { params }: Params) {
  const agent = await authorized(req, params);
  if (!agent) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ prompts: await db.agentComposerPrompt.findMany({ where: { agentId: agent.id }, orderBy: { updatedAt: 'desc' } }) });
}

export async function POST(req: Request, { params }: Params) {
  const agent = await authorized(req, params);
  if (!agent) return Response.json({ error: 'Not found' }, { status: 404 });
  const input = PromptSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: 'Invalid prompt' }, { status: 400 });
  const { data } = input;
  if (data.action === 'delete') {
    const result = await db.agentComposerPrompt.deleteMany({ where: { id: data.id, agentId: agent.id } });
    return Response.json({ ok: result.count === 1 }, { status: result.count ? 200 : 404 });
  }
  if (data.id) {
    const result = await db.agentComposerPrompt.updateMany({ where: { id: data.id, agentId: agent.id }, data: { title: data.title, content: data.content } });
    return Response.json({ ok: result.count === 1 }, { status: result.count ? 200 : 404 });
  }
  return Response.json(await db.agentComposerPrompt.create({ data: { agentId: agent.id, title: data.title, content: data.content } }), { status: 201 });
}
