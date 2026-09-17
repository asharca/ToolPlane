import 'server-only';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { generateToken, hashToken, tokenPrefix } from '@/lib/auth/token-format';
import { writeAudit } from '@/lib/observability/audit';
import { SITE } from '@/lib/site';
import { installClientLabel, resolveInstallClient } from '@/lib/plugin/clients';

function clientLabel(client: string): string {
  return installClientLabel(resolveInstallClient(client));
}

// Stable per-(workspace, toolkit, client) key name. The workspace prefix keeps
// same-slug toolkits from rotating each other's credentials.
function tokenName(workspaceSlug: string, toolkitSlug: string, client: string): string {
  return `${SITE.compactName} plugin - ${workspaceSlug}/${toolkitSlug} (${clientLabel(client)})`;
}

const LEGACY_PLUGIN_BRANDS = [...new Set([SITE.compactName, 'MCPmarket'])];

function legacyTokenNamePrefixes(toolkitSlug: string): string[] {
  return LEGACY_PLUGIN_BRANDS.map((brand) => `${brand} plugin - ${toolkitSlug} (`);
}

// Ensure an opaque install link exists for (toolkit, user). The link is just a
// stable, unguessable id → (toolkit, user) mapping; it stores NO token. Tokens
// are issued only by explicit registration POSTs (issueInstallToken).
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

export async function getToolkitInstallLinkDetails(id: string) {
  const link = await db.toolkitInstallLink.findUnique({
    where: { id },
    select: { userId: true, toolkit: { select: { id: true, slug: true, workspaceId: true, workspace: { select: { slug: true } } } } },
  });
  if (!link) return null;
  const user = await db.user.findFirst({ where: { id: link.userId, status: { not: 'suspended' } }, select: { id: true } });
  const toolkit = await db.toolkit.findFirst({ where: {
    id: link.toolkit.id, enabled: true,
    workspace: { status: 'active', OR: [{ ownerId: link.userId }, { members: { some: { userId: link.userId } } }] },
  }, select: { id: true } });
  return user && toolkit ? link : null;
}
const resolveLink = getToolkitInstallLinkDetails;

function bearerHash(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match ? hashToken(match[1]) : null;
}
export const INSTALL_TOKEN_GRACE_MS = 5 * 60_000;
export const MAX_ACTIVE_INSTALLATIONS = 100;

export type IssuedInstall = {
  installationId: string;
  workspaceId: string;
  toolkitId: string;
  token: string;
  workspaceSlug: string;
  toolkitSlug: string;
};

// A GET preview never calls this function. New registrations are independent;
// rotating a registration requires one of its still-valid credentials.
export async function issueInstallToken(
  id: string,
  client: string,
  options: { installationId?: string; authorization?: string | null; label?: string } = {},
): Promise<IssuedInstall | null> {
  const link = await resolveLink(id);
  if (!link) return null;
  const normalizedClient = resolveInstallClient(client);
  const label = (options.label ?? normalizedClient).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || normalizedClient;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${link.toolkit.workspaceId} FOR UPDATE`;
    const currentLink = await tx.toolkitInstallLink.findFirst({ where: { id, userId: link.userId, toolkitId: link.toolkit.id }, select: { id: true } });
    const activeUser = await tx.user.findFirst({ where: { id: link.userId, status: { not: 'suspended' } }, select: { id: true } });
    if (!currentLink || !activeUser) return null;
    const allowed = await tx.toolkit.findFirst({ where: { id: link.toolkit.id, enabled: true,
      workspace: { status: 'active', OR: [{ ownerId: link.userId }, { members: { some: { userId: link.userId } } }] },
    }, select: { id: true } });
    if (!allowed) return null;
    const now = new Date();
    let installation;
    if (options.installationId) {
      await tx.$queryRaw`SELECT id FROM "ToolkitInstallation" WHERE id = ${options.installationId} FOR UPDATE`;
      installation = await tx.toolkitInstallation.findFirst({ where: {
        id: options.installationId, userId: link.userId, toolkitId: link.toolkit.id, client: normalizedClient, status: 'active',
      } });
      const tokenHash = bearerHash(options.authorization);
      const authorized = installation && tokenHash && await tx.apiToken.findFirst({ where: {
        installationId: installation.id, tokenHash, userId: link.userId, toolkitId: link.toolkit.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      }, select: { id: true } });
      if (!authorized || !installation) return null;
      await tx.apiToken.deleteMany({ where: { installationId: installation.id, expiresAt: { lte: now } } });
      if (await tx.apiToken.count({ where: { installationId: installation.id } }) >= 3) {
        throw new Error('Too many concurrent rotations. Retry after the five-minute grace period.');
      }
      // This bounded grace period handles response loss/local write failure.
      // Never extend the expiry of a previously superseded key.
      await tx.apiToken.updateMany({ where: { installationId: installation.id, expiresAt: null },
        data: { expiresAt: new Date(now.getTime() + INSTALL_TOKEN_GRACE_MS) } });
      await tx.toolkitInstallation.update({ where: { id: installation.id }, data: { label } });
    } else {
      const count = await tx.toolkitInstallation.count({ where: { userId: link.userId, toolkitId: link.toolkit.id, status: 'active' } });
      if (count >= MAX_ACTIVE_INSTALLATIONS) throw new Error('Installation limit reached; revoke an unused registration first.');
      installation = await tx.toolkitInstallation.create({ data: { userId: link.userId, toolkitId: link.toolkit.id, client: normalizedClient, label } });
    }
    const token = generateToken();
    const name = `${tokenName(link.toolkit.workspace.slug, link.toolkit.slug, normalizedClient)} [${label}]`;
    const record = await tx.apiToken.create({ data: { userId: link.userId, toolkitId: link.toolkit.id,
      installationId: installation.id, name, prefix: tokenPrefix(token), tokenHash: hashToken(token) } });
    await writeAudit(tx, { actorId: link.userId, action: options.installationId ? 'installation.rotated' : 'installation.registered',
      targetType: 'toolkitInstallation', targetId: installation.id, changes: { client: normalizedClient, tokenId: record.id } });
    return { token, installationId: installation.id, workspaceSlug: link.toolkit.workspace.slug,
      toolkitSlug: link.toolkit.slug, workspaceId: link.toolkit.workspaceId, toolkitId: link.toolkit.id };
  });
}

// Self-service removal accepts an expired/revoked key ONLY to repeat that same
// removal, never to register, rotate or access any resource.
export async function revokeInstallationForLink(id: string, installationId: string, authorization: string | null, client: string) {
  const link = await resolveLink(id);
  const tokenHash = bearerHash(authorization);
  if (!link || !tokenHash) return null;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${link.toolkit.workspaceId} FOR UPDATE`;
    const currentLink = await tx.toolkitInstallLink.findFirst({ where: { id, userId: link.userId, toolkitId: link.toolkit.id }, select: { id: true } });
    if (!currentLink) return null;
    const installation = await tx.toolkitInstallation.findFirst({ where: {
      id: installationId, userId: link.userId, toolkitId: link.toolkit.id, client: resolveInstallClient(client),
      tokens: { some: { tokenHash, userId: link.userId, toolkitId: link.toolkit.id } },
    } });
    if (!installation) return null;
    await tx.toolkitInstallation.update({ where: { id: installation.id }, data: { status: 'revoked' } });
    await tx.apiToken.updateMany({ where: { installationId }, data: { expiresAt: new Date() } });
    await writeAudit(tx, { actorId: link.userId, action: 'installation.revoked', targetType: 'toolkitInstallation', targetId: installationId });
    return { workspaceSlug: link.toolkit.workspace.slug, toolkitSlug: link.toolkit.slug,
      workspaceId: link.toolkit.workspaceId, toolkitId: link.toolkit.id, client: installation.client };
  });
}

export type RevokedInstall = { workspaceSlug: string; toolkitSlug: string; workspaceId: string; toolkitId: string };

// Legacy all-client revocation helper; per-device uninstall uses the registration API.
export async function revokeInstallTokens(id: string): Promise<RevokedInstall | null> {
  const link = await resolveLink(id);
  if (!link) return null;

  const toolkitSlug = link.toolkit.slug;
  await db.apiToken.deleteMany({
    where: {
      userId: link.userId,
      OR: [
        { toolkitId: link.toolkit.id },
        ...legacyTokenNamePrefixes(toolkitSlug).map((prefix) => ({
          toolkitId: null,
          name: { startsWith: prefix },
        })),
      ],
    },
  });

  return { workspaceSlug: link.toolkit.workspace.slug, toolkitSlug, workspaceId: link.toolkit.workspaceId, toolkitId: link.toolkit.id };
}

// Delete actions call this before the Toolkit row cascades so credentials
// issued before toolkitId was recorded can also be revoked.
export async function revokeToolkitInstallTokens(toolkitId: string): Promise<void> {
  const toolkit = await db.toolkit.findUnique({
    where: { id: toolkitId },
    select: {
      slug: true,
      installLinks: { select: { userId: true } },
    },
  });
  if (!toolkit) return;

  const userIds = [...new Set(toolkit.installLinks.map(({ userId }) => userId))];
  await db.apiToken.deleteMany({
    where: {
      OR: [
        { toolkitId },
        ...(userIds.length > 0
          ? legacyTokenNamePrefixes(toolkit.slug).map((prefix) => ({
              toolkitId: null,
              userId: { in: userIds },
              name: { startsWith: prefix },
            }))
          : []),
      ],
    },
  });
}
