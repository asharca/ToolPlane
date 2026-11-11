import { withRequestLogging } from "@/lib/observability/http";
import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export const GET = withRequestLogging(
  "/api/v1/admin/logs/stream",
  async function GET(req: Request) {
    return handleLogRequest(req, { admin: true }, "stream");
  },
);
