import { withRequestLogging } from '@/lib/observability/http';
import { handleLocalA2A } from '@/lib/a2a/local-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;
const handler = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/a2a/local', async (req: Request,
  context: { params: Promise<{ slug: string; agentId: string }> }) => {
  const { slug, agentId } = await context.params;
  return handleLocalA2A(req, slug, agentId);
});
export const POST = handler;
export const GET = handler;
export const PUT = handler;
