import { handleMessageFeedback } from "@/lib/agents/evolution/http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
async function handle(
  req: Request,
  {
    params,
  }: {
    params: Promise<{
      agentId: string;
      conversationId: string;
      messageId: string;
    }>;
  },
) {
  const p = await params;
  return handleMessageFeedback(req, p.agentId, p.conversationId, p.messageId);
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/messages/[messageId]/feedback",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/messages/[messageId]/feedback",
  handle,
);
