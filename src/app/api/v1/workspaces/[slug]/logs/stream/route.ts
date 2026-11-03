import { handleLogRequest } from "@/lib/observability/views/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const values = await params;
  return handleLogRequest(req, { slug: values.slug }, "stream");
}
