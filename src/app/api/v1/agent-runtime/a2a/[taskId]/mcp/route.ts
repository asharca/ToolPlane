import { withRequestLogging } from '@/lib/observability/http';
import { handleLocalMcp } from '@/lib/a2a/local-mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withRequestLogging('/api/v1/agent-runtime/a2a/[taskId]/mcp', async (req: Request,
  context: { params: Promise<{ taskId: string }> }) => handleLocalMcp(req, (await context.params).taskId));
