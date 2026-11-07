import { withRequestLogging } from "@/lib/observability/http";
import { handleConsoleOutputEvents } from "@/lib/agents/execution/live-output-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/tasks/events",
  async (
    request: Request,
    context: { params: Promise<{ slug: string; agentId: string }> },
  ) => {
    const { slug, agentId } = await context.params;
    return handleConsoleOutputEvents(request, slug, agentId);
  },
);
