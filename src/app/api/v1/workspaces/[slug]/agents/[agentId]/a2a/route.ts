import { withRequestLogging } from '@/lib/observability/http';
import { manageA2AService } from '@/lib/a2a/management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/a2a',
  async (req: Request, ctx: { params: Promise<{ slug: string; agentId: string }> }) => {
    const { slug, agentId } = await ctx.params;
    return manageA2AService(req, slug, agentId);
  });
