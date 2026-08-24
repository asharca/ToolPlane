import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';

async function baseForUser(id: string, userId: string) {
  return db.knowledgeBase.findFirst({
    where: { id, workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] } },
    select: { id: true, workspaceId: true },
  });
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId } = await params;
  const base = await baseForUser(knowledgeBaseId, user.id);
  if (!base) return Response.json({ error: 'Knowledge base not found' }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: 'Bad request' }, { status: 400 }); }
  const providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
  if (providerId && !await db.modelProvider.findFirst({ where: { id: providerId, workspaceId: base.workspaceId }, select: { id: true } })) {
    return Response.json({ error: 'Embedding provider not found' }, { status: 400 });
  }
  const chunkSize = boundedNumber(body.chunkSize, 1200, 200, 8000);
  const chunkOverlap = boundedNumber(body.chunkOverlap, 200, 0, chunkSize - 1);
  const updated = await db.knowledgeBase.update({
    where: { id: base.id },
    data: {
      ...(typeof body.name === 'string' ? { name: body.name.trim().slice(0, 120) || 'Knowledge base' } : {}),
      ...(providerId ? { providerId } : {}),
      ...(typeof body.embeddingModel === 'string' ? { embeddingModel: body.embeddingModel.trim().slice(0, 200) } : {}),
      chunkSize,
      chunkOverlap,
      topK: Math.round(boundedNumber(body.topK, 6, 1, 20)),
      threshold: boundedNumber(body.threshold, 0.2, -1, 1),
    },
  });
  return Response.json(updated);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId } = await params;
  const base = await baseForUser(knowledgeBaseId, user.id);
  if (!base) return Response.json({ error: 'Knowledge base not found' }, { status: 404 });
  await db.knowledgeBase.delete({ where: { id: base.id } });
  return new Response(null, { status: 204 });
}
