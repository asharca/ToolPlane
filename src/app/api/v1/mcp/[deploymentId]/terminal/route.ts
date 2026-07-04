import { resolveLiveDeployment } from '@/lib/process/deployment-gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await params;
  const resolved = await resolveLiveDeployment(req, deploymentId);
  if ('response' in resolved) return resolved.response;

  const body = await req.text();
  const upstream = await fetch(`http://127.0.0.1:${resolved.port}/terminal/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body || '{}',
    signal: AbortSignal.timeout(10000),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
