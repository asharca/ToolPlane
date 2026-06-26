import { verifyApiToken } from '@/lib/auth/tokens';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

// Emit a one-shot install script (`curl … | bash`) that registers the toolkit's
// MCP servers (as one aggregated MCP endpoint) AND downloads each of its skills
// into ~/.claude/skills/<slug>/SKILL.md — so a toolkit installs both at once.
//
// Auth: an API token via `?token=` (so it works as a single curl URL) or the
// Authorization header. The validated token is embedded into the script for the
// runtime `claude mcp add` / skill-download calls.
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
    select: {
      name: true,
      servers: { select: { deploymentId: true } },
      skills: {
        select: {
          installedSkill: { select: { id: true, slug: true, skill: { select: { slug: true } } } },
        },
      },
    },
  });
  if (!toolkit) return text('# Toolkit not found.\n', 404);

  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const base = `${proto}://${host}`;
  const safeName = toolkit.name.replace(/["`$\\]/g, '');

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `TOKEN=${JSON.stringify(plaintext)}`,
    `BASE=${JSON.stringify(base)}`,
    `echo "Installing toolkit: ${safeName}"`,
    '',
    '# MCP: register all of this toolkit\'s servers as one aggregated MCP endpoint.',
    'if command -v claude >/dev/null 2>&1; then',
    `  claude mcp add --transport http ${JSON.stringify(toolkitSlug)} "$BASE/api/v1/workspaces/${slug}/toolkits/${toolkitSlug}/mcp" --header "Authorization: Bearer $TOKEN" \\`,
    `    && echo "  ✓ MCP registered (${toolkit.servers.length} server(s) — start them to expose tools)"`,
    'else',
    '  echo "  ! \'claude\' CLI not found — skipping MCP registration."',
    'fi',
    '',
  ];

  if (toolkit.skills.length > 0) {
    lines.push('# Skills: download each SKILL.md into the Claude skills directory.');
    lines.push('SKILLS_DIR="$HOME/.claude/skills"');
    for (const s of toolkit.skills) {
      const dir = (s.installedSkill.skill?.slug ?? s.installedSkill.slug ?? s.installedSkill.id).replace(/[^a-zA-Z0-9._-]/g, '-');
      lines.push(`mkdir -p "$SKILLS_DIR/${dir}"`);
      lines.push(
        `curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/skills/${s.installedSkill.id}/download" -o "$SKILLS_DIR/${dir}/SKILL.md" && echo "  ✓ skill ${dir}"`,
      );
    }
    lines.push('');
  }

  lines.push('echo "Done."', '');

  return new Response(lines.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' },
  });
}
