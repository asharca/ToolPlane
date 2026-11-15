import { withRequestLogging } from "@/lib/observability/http";
import { handleRuntimeToolApproval } from "@/lib/agents/execution/tool-approval-http";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/agent-runtime/tasks/[taskId]/tool-approvals",
  async (req: Request, { params }: { params: Promise<{ taskId: string }> }) =>
    handleRuntimeToolApproval(req, (await params).taskId),
);
