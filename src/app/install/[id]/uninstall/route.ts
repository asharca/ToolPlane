import { getToolkitInstallLinkDetails } from '@/lib/toolkits/install-link';
import { buildInstallBootstrap } from '@/lib/plugin/install-bootstrap';
import { installBaseFromRequest } from '@/lib/plugin/service-base';
import { resolveInstallClient } from '@/lib/plugin/clients';
export const runtime = 'nodejs';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = await getToolkitInstallLinkDetails(id);
  const headers = { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'private, no-store' };
  if (!link) return new Response('# Install link not found.\n', { status: 404, headers });
  return new Response(buildInstallBootstrap({ base: installBaseFromRequest(req), linkId: id,
    workspaceSlug: link.toolkit.workspace.slug, toolkitSlug: link.toolkit.slug,
    workspaceId: link.toolkit.workspaceId, toolkitId: link.toolkit.id,
    client: resolveInstallClient(new URL(req.url).searchParams.get('client')), uninstall: true }), { headers });
}
