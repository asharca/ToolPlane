import { withRequestLogging } from "@/lib/observability/http";
import { handleRuntimeUi } from "@/lib/agents/execution/ui-http";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/agent-runtime/tasks/[taskId]/ui",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ taskId: string }> },
  ) {
    return handleRuntimeUi(req, (await params).taskId);
  },
);
