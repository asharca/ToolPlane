import { withRequestLogging } from "@/lib/observability/http";
import { handleWorkUi } from "@/lib/agents/execution/work-ui";
export const runtime = "nodejs";
async function handler(
  req: Request,
  { params }: { params: Promise<{ slug: string; workSessionId: string }> },
) {
  const { slug, workSessionId } = await params;
  return handleWorkUi(req, slug, workSessionId);
}
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/work-sessions/[workSessionId]/ui",
  handler,
);
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/work-sessions/[workSessionId]/ui",
  handler,
);
