import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const values = await params;
  return handleLogRequest(req, { admin: true }, "a2a", values.taskId);
}
