import { withRequestLogging } from '@/lib/observability/http';
import { handleA2AConsoleRpc } from '@/lib/a2a/console-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/rpc', async (req: Request, ctx: { params: Promise<{ slug: string; agentId: string }> }) => {
  const { slug, agentId } = await ctx.params;
  return handleA2AConsoleRpc(req, slug, agentId);
});
