import { withRequestLogging } from "@/lib/observability/http";
import { handleConversationOutputEvents } from "@/lib/agents/execution/live-output-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/events",
  async (
    request: Request,
    context: { params: Promise<{ agentId: string; conversationId: string }> },
  ) => {
    const { agentId, conversationId } = await context.params;
    return handleConversationOutputEvents(request, agentId, conversationId);
  },
);
