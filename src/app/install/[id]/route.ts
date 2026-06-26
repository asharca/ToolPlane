import { issueInstallToken } from '@/lib/toolkits/install-link';
import { buildPluginInstallScript, resolveClient } from '@/lib/plugin/install-script';

export const runtime = 'nodejs';

// Public, tokenless install link: `/install/<opaque-id>` (matches the real
// site). Each fetch mints/rotates the toolkit's named install key and embeds the
// fresh token into the `curl | bash` plugin installer. No header / ?token needed.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const text = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const url = new URL(req.url);
  const client = resolveClient(url.searchParams.get('client'));

  const issued = await issueInstallToken(id, client);
  if (!issued) return text('# Install link not found or expired.\n', 404);

  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';

  const script = buildPluginInstallScript({
    base: `${proto}://${host}`,
    workspaceSlug: issued.workspaceSlug,
    toolkitSlug: issued.toolkitSlug,
    token: issued.token,
    client,
  });

  return new Response(script, {
    status: 200,
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}
