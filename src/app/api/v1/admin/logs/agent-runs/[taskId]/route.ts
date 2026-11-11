import { withRequestLogging } from "@/lib/observability/http";
import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/admin/logs/agent-runs/[taskId]",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ taskId: string }> },
  ) {
    const values = await params;
    return handleLogRequest(req, { admin: true }, "runs", values.taskId);
  },
);
