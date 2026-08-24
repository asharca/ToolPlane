import { basename } from 'node:path';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { mcpRpc } from '@/lib/process/mcp-client';
import { indexKnowledgeText } from '@/lib/knowledge';

export const runtime = 'nodejs';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

function safeName(name: string) {
  return basename(name).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 160) || 'upload.txt';
}

function resultText(result: Record<string, unknown> | null) {
  const content = result?.content;
  return Array.isArray(content) && typeof content[0] === 'object' && content[0]
    && typeof (content[0] as { text?: unknown }).text === 'string'
    ? (content[0] as { text: string }).text
    : null;
}

export async function POST(req: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { knowledgeBaseId } = await params;
  const form = await req.formData();
  const file = form.get('file');
  const sandboxId = typeof form.get('sandboxId') === 'string' ? String(form.get('sandboxId')) : '';
  if (!(file instanceof File) || !sandboxId) return Response.json({ error: 'file and sandboxId are required' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: 'File is too large' }, { status: 413 });
  if (!TEXT_TYPES.has(file.type) && !/\.(txt|md|mdx|csv|json)$/i.test(file.name)) {
    return Response.json({ error: 'Only text, Markdown, CSV, and JSON files are supported' }, { status: 415 });
  }
  const base = await db.knowledgeBase.findFirst({
    where: {
      id: knowledgeBaseId,
      workspace: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
    },
    select: { id: true, workspaceId: true },
  });
  if (!base) return Response.json({ error: 'Knowledge base not found' }, { status: 404 });
  const sandbox = await db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId: base.workspaceId },
    select: { id: true, deploymentId: true },
  });
  if (!sandbox) return Response.json({ error: 'Sandbox not found' }, { status: 404 });

  const filename = safeName(file.name);
  const path = `.toolplane/knowledge/${knowledgeBaseId}/${Date.now()}-${filename}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const write = await mcpRpc(sandbox.deploymentId, 'tools/call', {
    name: 'write_file',
    arguments: { path, content: bytes.toString('base64'), encoding: 'base64' },
  }, 30_000, { maxRequestBytes: MAX_UPLOAD_BYTES * 2 });
  if (!write || (write as { isError?: unknown }).isError) return Response.json({ error: resultText(write) || 'Sandbox write failed' }, { status: 502 });

  const document = await db.knowledgeDocument.create({
    data: {
      knowledgeBaseId,
      sandboxId: sandbox.id,
      sourcePath: path,
      filename,
      mimeType: file.type || 'text/plain',
      size: file.size,
      status: 'pending',
    },
  });
  try {
    await indexKnowledgeText(document.id, new TextDecoder().decode(bytes));
  } catch {
    // The document keeps its failed status and can be retried after provider configuration is fixed.
  }
  const updated = await db.knowledgeDocument.findUnique({ where: { id: document.id } });
  return Response.json(updated, { status: 201 });
}
