import 'server-only';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { SITE } from '@/lib/site';
import { installClientLabel, resolveInstallClient } from '@/lib/plugin/clients';

function clientLabel(client: string): string {
  return installClientLabel(resolveInstallClient(client));
}

// Stable per-(toolkit, client) key name. Re-installing overwrites the key of
// this exact name; uninstall revokes every key whose name starts with the
// per-toolkit prefix.
function tokenName(toolkitSlug: string, client: string): string {
  return `${SITE.compactName} plugin - ${toolkitSlug} (${clientLabel(client)})`;
}
function tokenNamePrefix(toolkitSlug: string): string {
  return `${SITE.compactName} plugin - ${toolkitSlug} (`;
}

// Ensure an opaque install link exists for (toolkit, user). The link is just a
// stable, unguessable id → (toolkit, user) mapping; it stores NO token. Tokens
// are minted fresh on each install fetch (issueInstallToken).
export async function getOrCreateToolkitInstallLink(
  toolkitId: string,
  userId: string,
): Promise<{ id: string }> {
  const existing = await db.toolkitInstallLink.findUnique({
    where: { toolkitId_userId: { toolkitId, userId } },
    select: { id: true },
  });
  if (existing) return existing;

  const id = randomBytes(32).toString('base64url');
  try {
    return await db.toolkitInstallLink.create({
      data: { id, toolkitId, userId },
      select: { id: true },
    });
  } catch {
    const link = await db.toolkitInstallLink.findUnique({
      where: { toolkitId_userId: { toolkitId, userId } },
      select: { id: true },
    });
    if (link) return link;
    throw new Error('failed to create toolkit install link');
  }
}

function resolveLink(id: string) {
  return db.toolkitInstallLink.findUnique({
    where: { id },
    select: {
      userId: true,
      toolkit: { select: { slug: true, workspace: { select: { slug: true } } } },
    },
  });
}

export type IssuedInstall = {
  token: string;
  workspaceSlug: string;
  toolkitSlug: string;
};

// Issue (rotate) the install token for an opaque link. Mirrors the real site:
// each call to the install URL overwrites a single named key
// ("<brand> plugin - <toolkit> (<client>)"), so the embedded credential is
// always freshly valid and can never silently go stale.
export async function issueInstallToken(
  id: string,
  client: string,
): Promise<IssuedInstall | null> {
  const link = await resolveLink(id);
  if (!link) return null;

  const toolkitSlug = link.toolkit.slug;
  const name = tokenName(toolkitSlug, client);
  // Overwrite: drop any prior key with this exact name, then mint a fresh one.
  await db.apiToken.deleteMany({ where: { userId: link.userId, name } });
  const { token } = await createApiToken(link.userId, name);

  return { token, workspaceSlug: link.toolkit.workspace.slug, toolkitSlug };
}

export type RevokedInstall = { workspaceSlug: string; toolkitSlug: string };

// Revoke every install key for the toolkit (all clients) — used by uninstall.
export async function revokeInstallTokens(id: string): Promise<RevokedInstall | null> {
  const link = await resolveLink(id);
  if (!link) return null;

  const toolkitSlug = link.toolkit.slug;
  await db.apiToken.deleteMany({
    where: { userId: link.userId, name: { startsWith: tokenNamePrefix(toolkitSlug) } },
  });

  return { workspaceSlug: link.toolkit.workspace.slug, toolkitSlug };
}
