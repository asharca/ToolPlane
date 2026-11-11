import { withRequestLogging } from "@/lib/observability/http";
import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/workspaces/[slug]/logs/a2a-tasks",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    const values = await params;
    return handleLogRequest(req, { slug: values.slug }, "a2a");
  },
);
