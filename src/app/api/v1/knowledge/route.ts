import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';

async function workspaceForUser(slug: string, userId: string) {
  return db.workspace.findFirst({
    where: { slug, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    select: { id: true },
  });
}

export async function GET(req: Request) {
  const user = await resolveRequestUser(req);
  const slug = new URL(req.url).searchParams.get('workspace')?.trim();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!slug) return Response.json({ error: 'workspace is required' }, { status: 400 });
  const workspace = await workspaceForUser(slug, user.id);
  if (!workspace) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(await db.knowledgeBase.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      provider: { select: { id: true, name: true } },
      documents: { orderBy: { updatedAt: 'desc' } },
      agentLinks: { include: { agent: { select: { id: true, name: true } } } },
    },
  }));
}

export async function POST(req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { workspace?: unknown; name?: unknown; providerId?: unknown; embeddingModel?: unknown; chunkSize?: unknown; chunkOverlap?: unknown; topK?: unknown; threshold?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  if (typeof body.workspace !== 'string' || typeof body.name !== 'string' || typeof body.providerId !== 'string' || typeof body.embeddingModel !== 'string') {
    return Response.json({ error: 'workspace, name, providerId, and embeddingModel are required' }, { status: 400 });
  }
  const workspace = await workspaceForUser(body.workspace.trim(), user.id);
  if (!workspace) return Response.json({ error: 'Not found' }, { status: 404 });
  const provider = await db.modelProvider.findFirst({ where: { id: body.providerId, workspaceId: workspace.id }, select: { id: true } });
  if (!provider) return Response.json({ error: 'Embedding provider not found' }, { status: 400 });
  const chunkSize = Math.min(8000, Math.max(200, Number(body.chunkSize) || 1200));
  const chunkOverlap = Math.min(chunkSize - 1, Math.max(0, Number(body.chunkOverlap) || 200));
  try {
    const base = await db.knowledgeBase.create({
      data: {
        workspaceId: workspace.id,
        name: body.name.trim().slice(0, 120) || 'Knowledge base',
        providerId: provider.id,
        embeddingModel: body.embeddingModel.trim().slice(0, 200),
        chunkSize,
        chunkOverlap,
        topK: Math.min(20, Math.max(1, Math.round(Number(body.topK) || 6))),
        threshold: Math.min(1, Math.max(-1, Number(body.threshold) || 0.2)),
      },
    });
    return Response.json(base, { status: 201 });
  } catch {
    return Response.json({ error: 'A knowledge base with this name already exists' }, { status: 409 });
  }
}
