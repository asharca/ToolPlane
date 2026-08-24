import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';

export async function PUT(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId } = await params;
  let body: { agentIds?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  if (!Array.isArray(body.agentIds) || body.agentIds.some((id) => typeof id !== 'string')) {
    return Response.json({ error: 'agentIds must be an array' }, { status: 400 });
  }
  const base = await db.knowledgeBase.findFirst({
    where: { id: knowledgeBaseId, workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] } },
    select: { id: true, workspaceId: true },
  });
  if (!base) return Response.json({ error: 'Knowledge base not found' }, { status: 404 });
  const agentIds = [...new Set(body.agentIds)];
  const agents = await db.agent.findMany({ where: { id: { in: agentIds }, workspaceId: base.workspaceId }, select: { id: true } });
  if (agents.length !== agentIds.length) return Response.json({ error: 'Agent not found' }, { status:400 });
  await db.$transaction([
    db.agentKnowledgeBase.deleteMany({ where: { knowledgeBaseId } }),
    db.agentKnowledgeBase.createMany({ data: agents.map((agent) => ({ agentId: agent.id, knowledgeBaseId })) }),
  ]);
  return Response.json({ agentIds: agents.map((agent) => agent.id) });
}
