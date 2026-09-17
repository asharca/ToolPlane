import { withRequestLogging } from '@/lib/observability/http';
import { agentRuntimeTokenFromRequest, bindRuntimeLogContext } from '@/lib/agents/runtime-access';
import { isAgentRuntimeGrantCurrent } from '@/lib/agents/runtime-grant';
import { authorizeRun } from '@/lib/agents/collaboration/service';
import { handleCollaborationMcp } from '@/lib/agents/collaboration/mcp';
import { collaborationJson, collaborationHttpError } from '@/lib/agents/collaboration/http';
import { db } from '@/lib/db';
export const runtime = 'nodejs';
export const maxDuration = 30;
export const POST = withRequestLogging('/api/v1/agent-runtime/collaboration/[runId]/mcp', async (req: Request,
  { params }: { params: Promise<{ runId: string }> }) => {
  const token = await agentRuntimeTokenFromRequest(req);
  const { runId } = await params;
  if (!token || token.collaborationRunId !== runId) return collaborationJson({ error: 'unauthorized' }, 401);
  if (!await isAgentRuntimeGrantCurrent(token)) return collaborationJson({ error: 'grant_revoked' }, 403);
  const principal = { kind: 'runtime' as const, workspaceId: token.workspaceId, agentId: token.agentId, runId };
  try {
    await authorizeRun(db, principal);
    bindRuntimeLogContext(token);
    return await handleCollaborationMcp(req, principal);
  } catch (error) { return collaborationHttpError(error); }
});
export function GET() { return collaborationJson({ error: 'Use POST for MCP JSON-RPC.' }, 405); }
