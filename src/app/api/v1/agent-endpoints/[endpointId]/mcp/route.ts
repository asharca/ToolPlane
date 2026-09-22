import { withRequestLogging } from '@/lib/observability/http';
import { handleAgentServiceMcp } from '@/lib/agents/public-api/service-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

type Context = { params: Promise<{ endpointId: string }> };
const handler = withRequestLogging('/api/v1/agent-endpoints/[endpointId]/mcp',
  async (request: Request, context: Context) => {
    const { endpointId } = await context.params;
    return handleAgentServiceMcp(request, endpointId);
  });

export const POST = handler;
export const GET = handler;
export const DELETE = handler;
export const OPTIONS = handler;
