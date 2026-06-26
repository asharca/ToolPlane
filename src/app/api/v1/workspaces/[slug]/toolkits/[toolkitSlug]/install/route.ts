import { verifyApiToken } from '@/lib/auth/tokens';
import { db } from '@/lib/db';
import { buildPluginInstallScript } from '@/lib/plugin/install-script';

export const runtime = 'nodejs';

// Emits the `curl … | bash` installer that scaffolds the toolkit as one local
// Claude Code plugin (MCP tools + auto-syncing skills). Auth via `?token=` (so
// it works as a single curl URL) or the Authorization header; the validated
// plaintext token is embedded into the plugin's .mcp.json for the gateway.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; toolkitSlug: string }> },
) {
  const { slug, toolkitSlug } = await params;
  const url = new URL(req.url);
  const qToken = url.searchParams.get('token');
  const authHeader = qToken ? `Bearer ${qToken}` : req.headers.get('authorization');
  const user = await verifyApiToken(authHeader);
  const plaintext = qToken ?? (authHeader ?? '').replace(/^Bearer\s+/i, '');

  const text = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  if (!user || !plaintext) {
    return text('# Unauthorized. Append ?token=<API_TOKEN> (Settings → API Tokens).\n', 401);
  }

  const toolkit = await db.toolkit.findFirst({
    where: {
      slug: toolkitSlug,
      workspace: {
        slug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true },
  });
  if (!toolkit) return text('# Toolkit not found.\n', 404);

  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const base = `${proto}://${host}`;

  const script = buildPluginInstallScript({
    base,
    workspaceSlug: slug,
    toolkitSlug,
    token: plaintext,
    client: url.searchParams.get('client'),
  });

  return new Response(script, {
    status: 200,
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}
