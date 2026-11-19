import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { searchKnowledgeBases } from "@/lib/knowledge";
import { KnowledgeError, knowledgeFailures } from "@/lib/knowledge/errors";
import { logSystemEvent } from "@/lib/observability/system";

export const POST = withRequestLogging(
  "/api/v1/knowledge/[knowledgeBaseId]/search",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ knowledgeBaseId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { knowledgeBaseId } = await params;
    let body: { query?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    if (
      typeof body.query !== "string" ||
      !body.query.trim() ||
      body.query.length > 4_000
    ) {
      return Response.json({ error: "query is required" }, { status: 400 });
    }
    const base = await db.knowledgeBase.findFirst({
      where: {
        id: knowledgeBaseId,
        workspace: workspaceAccessWhere(user.id),
      },
      select: {
        id: true,
        embeddingModel: true,
        topK: true,
        threshold: true,
        provider: { select: { format: true, baseUrl: true, apiKey: true } },
      },
    });
    if (!base)
      return Response.json(
        { error: "Knowledge base not found" },
        { status: 404 },
      );
    try {
      return Response.json({
        sources: await searchKnowledgeBases([base], body.query),
      });
    } catch (error) {
      const code =
        error instanceof KnowledgeError
          ? error.code
          : "KNOWLEDGE_SEARCH_FAILED";
      logSystemEvent("knowledge.search_failed", { error, errorCode: code });
      return Response.json(
        { error: knowledgeFailures.text(code), code },
        { status: 502 },
      );
    }
  },
);
