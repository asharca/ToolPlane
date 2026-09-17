import { withRequestLogging } from '@/lib/observability/http';
import { resolveRequestPrincipal } from '@/lib/auth/request-user';
import { toolkitAccessWhere } from '@/lib/auth/toolkit-scope';
import { db } from '@/lib/db';
import { installBaseFromRequest } from '@/lib/plugin/service-base';
import { buildInstallBootstrap } from '@/lib/plugin/install-bootstrap';
import { resolveInstallClient } from '@/lib/plugin/clients';
import { getOrCreateToolkitInstallLink } from '@/lib/toolkits/install-link';

export const runtime = 'nodejs';
// Personal credentials authorize this bootstrap only. They are never copied
// into a client config. Query-string tokens are deliberately no longer accepted.
export const GET = withRequestLogging('/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/install', async function GET(
  req: Request, { params }: { params: Promise<{ slug: string; toolkitSlug: string }> },
) {
  const { slug, toolkitSlug } = await params;
  const headers = { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'private, no-store' };
  const principal = await resolveRequestPrincipal(req, { allowSession: false });
  if (!principal || principal.credential !== 'personal-token') return new Response('# Personal Bearer token required in Authorization header.\n', { status: 401, headers });
  const toolkit = await db.toolkit.findFirst({ where: toolkitAccessWhere(principal, slug, toolkitSlug), select: { id: true, workspaceId: true } });
  if (!toolkit) return new Response('# Toolkit not found.\n', { status: 404, headers });
  const link = await getOrCreateToolkitInstallLink(toolkit.id, principal.user.id);
  return new Response(buildInstallBootstrap({ base: installBaseFromRequest(req), linkId: link.id,
    workspaceSlug: slug, toolkitSlug, workspaceId: toolkit.workspaceId, toolkitId: toolkit.id,
    client: resolveInstallClient(new URL(req.url).searchParams.get('client')) }), { headers });
});
