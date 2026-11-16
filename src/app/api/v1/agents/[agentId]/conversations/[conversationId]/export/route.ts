import { withRequestLogging } from "@/lib/observability/http";
import { handleConversationExport } from "@/lib/agents/conversation-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ agentId: string; conversationId: string }> };
async function exportConversation(req: Request, { params }: Context) {
  const { agentId, conversationId } = await params;
  return handleConversationExport(req, agentId, conversationId);
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/export",
  exportConversation,
);
