import { withRequestLogging } from '@/lib/observability/http';
import { handleRemoteRegistry } from '@/lib/a2a/remote-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ slug: string; agentId: string }> };
const route = '/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/remotes';
export const GET = withRequestLogging(route, async (req: Request, context: Context) => {
  const { slug, agentId } = await context.params; return handleRemoteRegistry(req, slug, agentId);
});
export const POST = GET;
