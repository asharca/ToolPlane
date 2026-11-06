import { handleAgentAutomation } from "@/lib/agents/automation-http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const values = await params;
  return handleAgentAutomation(req, values.agentId, "usage");
}
export const GET = withRequestLogging("/api/v1/agents/[agentId]/usage", handle);
