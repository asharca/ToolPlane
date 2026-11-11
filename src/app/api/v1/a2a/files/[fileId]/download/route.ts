import { withRequestLogging } from "@/lib/observability/http";
import { taskFileSessionDownload } from "@/lib/a2a/file-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/a2a/files/[fileId]/download",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ fileId: string }> },
  ) {
    return taskFileSessionDownload(req, (await params).fileId);
  },
);
