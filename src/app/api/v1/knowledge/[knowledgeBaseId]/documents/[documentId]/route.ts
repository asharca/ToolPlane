import { workspaceAccessWhere } from "@/lib/workspace/scope";
import type { Prisma } from "@prisma/client";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { mcpRpc } from "@/lib/process/mcp-client";
import { indexKnowledgeText } from "@/lib/knowledge";
import { KnowledgeError, knowledgeFailures } from "@/lib/knowledge/errors";
import { logSystemEvent } from "@/lib/observability/system";

function documentScope(
  documentId: string,
  knowledgeBaseId: string,
  userId: string,
): Prisma.KnowledgeDocumentWhereInput {
  return {
    id: documentId,
    knowledgeBaseId,
    knowledgeBase: {
      workspace: workspaceAccessWhere(userId),
    },
  };
}

function resultText(result: Record<string, unknown> | null) {
  const content = result?.content;
  return Array.isArray(content) &&
    content[0] &&
    typeof content[0] === "object" &&
    typeof (content[0] as { text?: unknown }).text === "string"
    ? (content[0] as { text: string }).text
    : null;
}

export const POST = withRequestLogging(
  "/api/v1/knowledge/[knowledgeBaseId]/documents/[documentId]",
  async function POST(
    req: Request,
    {
      params,
    }: { params: Promise<{ knowledgeBaseId: string; documentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { knowledgeBaseId, documentId } = await params;
    const where = documentScope(documentId, knowledgeBaseId, user.id);
    const document = await db.knowledgeDocument.findFirst({
      where,
      include: { sandbox: { select: { deploymentId: true } } },
    });
    if (!document?.sandbox)
      return Response.json(
        { error: "Source sandbox is unavailable" },
        { status: 404 },
      );
    const result = await mcpRpc(
      document.sandbox.deploymentId,
      "tools/call",
      { name: "read_file", arguments: { path: document.sourcePath } },
      undefined,
      { internal: true },
    );
    const raw = result?.isError ? null : resultText(result);
    if (!raw)
      return Response.json(
        { error: "Source file is unavailable" },
        { status: 502 },
      );
    let content = raw;
    try {
      const parsed = JSON.parse(raw) as { content?: unknown };
      if (typeof parsed.content === "string") content = parsed.content;
    } catch {
      // Some sandbox connectors return the file text directly.
    }
    try {
      await indexKnowledgeText(where, content);
    } catch (error) {
      const code =
        error instanceof KnowledgeError ? error.code : "KNOWLEDGE_INDEX_FAILED";
      if (!(error instanceof KnowledgeError))
        logSystemEvent("knowledge.documents.reindex_failed", {
          error,
          errorCode: code,
        });
      return Response.json(
        { error: knowledgeFailures.text(code), code },
        { status: code === "KNOWLEDGE_DOCUMENT_NOT_FOUND" ? 404 : 502 },
      );
    }
    const updated = await db.knowledgeDocument.findFirst({ where });
    return updated
      ? Response.json(updated)
      : Response.json({ error: "Document not found" }, { status: 404 });
  },
);

export const DELETE = withRequestLogging(
  "/api/v1/knowledge/[knowledgeBaseId]/documents/[documentId]",
  async function DELETE(
    req: Request,
    {
      params,
    }: { params: Promise<{ knowledgeBaseId: string; documentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { knowledgeBaseId, documentId } = await params;
    const deleted = await db.knowledgeDocument.deleteMany({
      where: documentScope(documentId, knowledgeBaseId, user.id),
    });
    if (!deleted.count)
      return Response.json({ error: "Document not found" }, { status: 404 });
    return new Response(null, { status: 204 });
  },
);
