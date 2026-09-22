import { withRequestLogging } from '@/lib/observability/http';
import { handleA2ACard } from '@/lib/a2a/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = withRequestLogging('/api/v1/agent-endpoints/[endpointId]/a2a/.well-known/agent-card.json', async (
  request: Request, context: { params: Promise<{ endpointId: string }> },
) => handleA2ACard(request, (await context.params).endpointId));
