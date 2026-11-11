import { withRequestLogging } from "@/lib/observability/http";
import { handleConsoleUi } from "@/lib/agents/execution/ui-http";
export const runtime = "nodejs";
async function handler(
  req: Request,
  { params }: { params: Promise<{ slug: string; agentId: string }> },
) {
  const { slug, agentId } = await params;
  return handleConsoleUi(req, slug, agentId);
}
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/ui",
  handler,
);
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/ui",
  handler,
);
