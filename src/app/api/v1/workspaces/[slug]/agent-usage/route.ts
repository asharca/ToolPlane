import { handleWorkspaceAgentUsage } from "@/lib/agents/automation-http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/agent-usage",
  async (req: Request, { params }: { params: Promise<{ slug: string }> }) =>
    handleWorkspaceAgentUsage(req, (await params).slug),
);
