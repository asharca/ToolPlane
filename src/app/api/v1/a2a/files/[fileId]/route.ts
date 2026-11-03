import { taskFileDownload } from "@/lib/a2a/file-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  return taskFileDownload(req, (await params).fileId);
}
