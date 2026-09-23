import { handleConsoleApprovals } from '@/lib/a2a/approval-http';
export const runtime = 'nodejs';
async function handler(req: Request, { params }: { params: Promise<{ slug: string; agentId: string }> }) {
  const { slug, agentId } = await params;
  return handleConsoleApprovals(req, slug, agentId);
}
export const GET = handler;
export const POST = handler;
