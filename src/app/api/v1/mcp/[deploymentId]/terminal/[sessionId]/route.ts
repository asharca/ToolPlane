import { resolveLiveDeployment } from '@/lib/process/deployment-gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string; sessionId: string }> },
) {
  const { deploymentId, sessionId } = await params;
  const resolved = await resolveLiveDeployment(req, deploymentId);
  if ('response' in resolved) return resolved.response;

  const upstream = await fetch(
    `http://127.0.0.1:${resolved.port}/terminal/session/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', signal: AbortSignal.timeout(10000) },
  );
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
