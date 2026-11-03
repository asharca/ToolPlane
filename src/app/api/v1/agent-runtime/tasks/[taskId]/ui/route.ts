import { handleRuntimeUi } from "@/lib/agents/execution/ui-http";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  return handleRuntimeUi(req, (await params).taskId);
}
