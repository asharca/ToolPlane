import { withRequestLogging } from "@/lib/observability/http";
import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/admin/logs/a2a-tasks",
  async function GET(req: Request) {
    return handleLogRequest(req, { admin: true }, "a2a");
  },
);
