import { withRequestLogging } from '@/lib/observability/http';
import { handleA2ARpc } from '@/lib/a2a/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;
export const POST = withRequestLogging('/api/v1/agent-endpoints/[endpointId]/a2a', async (
  request: Request, context: { params: Promise<{ endpointId: string }> },
) => handleA2ARpc(request, (await context.params).endpointId));
