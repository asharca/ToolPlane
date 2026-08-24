import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { searchKnowledgeBases } from '@/lib/knowledge';

export async function POST(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId } = await params;
  let body: { query?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 4_000) {
    return Response.json({ error: 'query is required' }, { status: 400 });
  }
  const base = await db.knowledgeBase.findFirst({
    where: { id: knowledgeBaseId, workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] } },
    select: { id: true, embeddingModel: true, topK: true, threshold: true, provider: { select: { format: true, baseUrl: true, apiKey: true } } },
  });
  if (!base) return Response.json({ error: 'Knowledge base not found' }, { status: 404 });
  try {
    return Response.json({ sources: await searchKnowledgeBases([base], body.query) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Search failed' }, { status: 502 });
  }
}
