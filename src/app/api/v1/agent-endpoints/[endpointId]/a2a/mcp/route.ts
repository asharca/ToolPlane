import { withRequestLogging } from '@/lib/observability/http';
import { handleServiceMcp } from '@/lib/a2a/service-mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handler = withRequestLogging('/api/v1/agent-endpoints/[endpointId]/a2a/mcp',
  async (request: Request, context: { params: Promise<{ endpointId: string }> }) => handleServiceMcp(request, (await context.params).endpointId));
export const POST = handler;
export const GET = handler;
export const DELETE = handler;
