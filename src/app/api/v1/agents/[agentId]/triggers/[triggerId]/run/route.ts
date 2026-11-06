import { handleAgentAutomation } from "@/lib/agents/automation-http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string; triggerId: string }> },
) {
  const values = await params;
  return handleAgentAutomation(req, values.agentId, "run", values.triggerId);
}
export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/triggers/[triggerId]/run",
  handle,
);
