import { withRequestLogging } from '@/lib/observability/http';
import { resolveLiveDeployment } from '@/lib/process/deployment-gateway';
import { workspaceAccessStream } from '@/lib/workspace/access-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRequestLogging("/api/v1/mcp/[deploymentId]/terminal/[sessionId]/stream", async function GET(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string; sessionId: string }> },
) {
  const { deploymentId, sessionId } = await params;
  const resolved = await resolveLiveDeployment(req, deploymentId);
  if ('response' in resolved) return resolved.response;

  const upstream = await fetch(
    `http://127.0.0.1:${resolved.port}/terminal/session/${encodeURIComponent(sessionId)}/stream`,
    {
      headers: { accept: 'text/event-stream' },
      signal: req.signal,
    },
  );
  if (!upstream.body) {
    return new Response(JSON.stringify({ error: 'terminal stream unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(workspaceAccessStream(upstream.body, resolved.dep.workspaceId, resolved.userId, req.signal), {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
