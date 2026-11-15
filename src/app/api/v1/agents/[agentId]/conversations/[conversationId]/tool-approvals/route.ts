import { withRequestLogging } from "@/lib/observability/http";
import { handleConversationToolApprovals } from "@/lib/agents/execution/tool-approval-http";
export const runtime = "nodejs";
const path =
  "/api/v1/agents/[agentId]/conversations/[conversationId]/tool-approvals";
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string; conversationId: string }> },
) {
  const { agentId, conversationId } = await params;
  return handleConversationToolApprovals(req, agentId, conversationId);
}
export const GET = withRequestLogging(path, handle);
export const POST = withRequestLogging(path, handle);
