import { revokeInstallTokens } from '@/lib/toolkits/install-link';
import { buildPluginUninstallScript } from '@/lib/plugin/install-script';

export const runtime = 'nodejs';

// Public uninstaller: `/install/<opaque-id>/uninstall`. Revokes the toolkit's
// install key(s) server-side, then returns a `curl | bash` script that
// unregisters the plugin from Claude Code and removes its directory (skills
// included). No header / ?token needed.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const text = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const revoked = await revokeInstallTokens(id);
  if (!revoked) return text('# Install link not found.\n', 404);

  const script = buildPluginUninstallScript({ toolkitSlug: revoked.toolkitSlug });
  return new Response(script, {
    status: 200,
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}
