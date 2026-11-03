import { withRequestLogging } from "@/lib/observability/http";
import { handleRuntimeTools } from "@/lib/agents/execution/runtime-tools";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withRequestLogging(
  "/api/v1/agent-runtime/tasks/[taskId]/tools",
  async (req: Request, context: { params: Promise<{ taskId: string }> }) =>
    handleRuntimeTools(req, (await context.params).taskId),
);
