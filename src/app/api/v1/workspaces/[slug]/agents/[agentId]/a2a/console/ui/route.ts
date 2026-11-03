import { handleConsoleUi } from "@/lib/agents/execution/ui-http";
export const runtime = "nodejs";
async function handler(
  req: Request,
  { params }: { params: Promise<{ slug: string; agentId: string }> },
) {
  const { slug, agentId } = await params;
  return handleConsoleUi(req, slug, agentId);
}
export const GET = handler;
export const POST = handler;
