import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { mcpRpc } from '@/lib/process/mcp-client';
import { indexKnowledgeText } from '@/lib/knowledge';

async function documentForUser(documentId: string, knowledgeBaseId: string, userId: string) {
  return db.knowledgeDocument.findFirst({
    where: {
      id: documentId,
      knowledgeBaseId,
      knowledgeBase: { workspace: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] } },
    },
    include: { sandbox: { select: { deploymentId: true } } },
  });
}

function resultText(result: Record<string, unknown> | null) {
  const content = result?.content;
  return Array.isArray(content) && content[0] && typeof content[0] === 'object'
    && typeof (content[0] as { text?: unknown }).text === 'string'
    ? (content[0] as { text: string }).text
    : null;
}

export async function POST(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string; documentId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId, documentId } = await params;
  const document = await documentForUser(documentId, knowledgeBaseId, user.id);
  if (!document?.sandbox) return Response.json({ error: 'Source sandbox is unavailable' }, { status: 404 });
  const result = await mcpRpc(document.sandbox.deploymentId, 'tools/call', { name: 'read_file', arguments: { path: document.sourcePath } });
  const raw = resultText(result);
  if (!raw) return Response.json({ error: 'Source file is unavailable' }, { status: 502 });
  let content = raw;
  try {
    const parsed = JSON.parse(raw) as { content?: unknown };
    if (typeof parsed.content === 'string') content = parsed.content;
  } catch {
    // Some sandbox connectors return the file text directly.
  }
  try {
    await indexKnowledgeText(document.id, content);
    return Response.json(await db.knowledgeDocument.findUnique({ where: { id: document.id } }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Reindex failed' }, { status: 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string; documentId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId, documentId } = await params;
  const document = await documentForUser(documentId, knowledgeBaseId, user.id);
  if (!document) return Response.json({ error: 'Document not found' }, { status: 404 });
  await db.knowledgeDocument.delete({ where: { id: document.id } });
  return new Response(null, { status: 204 });
}
