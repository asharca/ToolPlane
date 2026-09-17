import { z } from 'zod';
import { getToolkitInstallLinkDetails, issueInstallToken, revokeInstallationForLink } from '@/lib/toolkits/install-link';
import { buildToolkitInstallScript, buildPluginUninstallScript, resolveClient } from '@/lib/plugin/install-script';
import { buildInstallBootstrap } from '@/lib/plugin/install-bootstrap';
import { isSameOriginRequest } from '@/lib/http/origin';
import { installBaseFromRequest } from '@/lib/plugin/service-base';
import { parseJson } from '@/lib/agents/public-api/body';
import { INSTALL_CLIENTS } from '@/lib/plugin/clients';

export const runtime = 'nodejs';
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
const Body = z.object({ client: z.enum(INSTALL_CLIENTS), operation: z.enum(['install', 'revoke']).default('install'),
  installationId: z.string().min(1).max(128).optional(), label: z.string().max(80).optional() }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = await getToolkitInstallLinkDetails(id);
  if (!link) return new Response('# Install link not found or expired.\n', { status: 404, headers });
  const script = buildInstallBootstrap({ base: installBaseFromRequest(req), linkId: id,
    workspaceSlug: link.toolkit.workspace.slug, toolkitSlug: link.toolkit.slug,
    workspaceId: link.toolkit.workspaceId, toolkitId: link.toolkit.id,
    client: resolveClient(new URL(req.url).searchParams.get('client')) });
  return new Response(script, { headers: { ...headers, 'content-type': 'text/x-shellscript; charset=utf-8' } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Non-browser installers omit Origin; browser calls must be same-origin JSON.
  if ((req.headers.get('origin') && !isSameOriginRequest(req)) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'Invalid origin or content type' }, { status: 403, headers });
  }
  const { id } = await params;
  const parsed = await parseJson(req, Body, 4096);
  if (!parsed.ok) return Response.json({ error: 'Invalid request' }, { status: 400, headers });
  const body = parsed.value;
  try {
    if (body.operation === 'revoke') {
      if (!body.installationId) return Response.json({ error: 'Registration required' }, { status: 400, headers });
      const revoked = await revokeInstallationForLink(id, body.installationId, req.headers.get('authorization'), body.client);
      if (!revoked || revoked.client !== body.client) return Response.json({ error: 'Installation not found' }, { status: 404, headers });
      return Response.json({ installationId: body.installationId,
        script: buildPluginUninstallScript({ ...revoked, base: installBaseFromRequest(req), client: body.client }) }, { headers });
    }
    const issued = await issueInstallToken(id, body.client, { installationId: body.installationId,
      authorization: req.headers.get('authorization'), label: body.label });
    if (!issued) return Response.json({ error: 'Invalid installation credentials or link' }, { status: 401, headers });
    return Response.json({ installationId: issued.installationId,
      script: buildToolkitInstallScript({ ...issued, base: installBaseFromRequest(req), client: body.client }) }, { headers });
  } catch {
    return Response.json({ error: 'Installation update failed. Retry after the rotation grace period or revoke an unused registration.' }, { status: 409, headers });
  }
}
