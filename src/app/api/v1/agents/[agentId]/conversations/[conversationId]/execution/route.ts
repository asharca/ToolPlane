import { withRequestLogging } from "@/lib/observability/http";
import { handleConversationExecution } from "@/lib/agents/execution/conversation-http";

export const runtime = "nodejs";
const path =
  "/api/v1/agents/[agentId]/conversations/[conversationId]/execution";
type Context = { params: Promise<{ agentId: string; conversationId: string }> };

async function execution(req: Request, { params }: Context) {
  const { agentId, conversationId } = await params;
  return handleConversationExecution(req, agentId, conversationId);
}

export const GET = withRequestLogging(path, execution);
export const POST = withRequestLogging(path, execution);
