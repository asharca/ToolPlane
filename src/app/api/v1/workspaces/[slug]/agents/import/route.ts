import { withRequestLogging } from "@/lib/observability/http";
import { handleOmpImport } from "./_shared";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/agents/import",
  async function POST(
    request: Request,
    { params }: { params: Promise<{ slug: string }> },
  ) {
    return handleOmpImport(request, (await params).slug, true);
  },
);
