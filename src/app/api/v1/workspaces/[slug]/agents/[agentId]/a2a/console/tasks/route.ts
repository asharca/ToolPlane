import { withRequestLogging } from '@/lib/observability/http';
import { handleA2AConsoleTasks } from '@/lib/a2a/console-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = withRequestLogging('/api/v1/workspaces/[slug]/agents/[agentId]/a2a/console/tasks',
  async (request: Request, context: { params: Promise<{ slug: string; agentId: string }> }) => {
    const { slug, agentId } = await context.params;
    return handleA2AConsoleTasks(request, slug, agentId);
  });
