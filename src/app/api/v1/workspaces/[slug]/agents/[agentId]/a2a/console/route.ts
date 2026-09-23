import { withRequestLogging } from '@/lib/observability/http';
import { handleA2AConsole } from '@/lib/a2a/console-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ slug: string; agentId: string }> };
const handle = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console', async (req: Request, ctx: Context) => {
  const { slug, agentId } = await ctx.params;
  return handleA2AConsole(req, slug, agentId);
});
export const GET = handle;
export const POST = handle;
