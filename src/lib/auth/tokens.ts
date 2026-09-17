import 'server-only';
import { db } from '@/lib/db';
import { generateToken, hashToken, tokenPrefix } from './token-format';
import { writeAudit } from '@/lib/observability/audit';

export { generateToken, hashToken, tokenPrefix } from './token-format';

export async function createApiToken(
  userId: string,
  name: string,
  options: { toolkitId?: string } = {},
) {
  const token = generateToken();
  const record = await db.$transaction(async (tx) => {
    const record = await tx.apiToken.create({
    data: {
      userId,
      toolkitId: options.toolkitId,
      name: name.trim() || 'Default token',
      prefix: tokenPrefix(token),
      tokenHash: hashToken(token),
    },
    });
    await writeAudit(tx, { actorId: userId, action: 'credential.created', targetType: 'apiToken', targetId: record.id });
    return record;
  });
  return { token, record };
}

export function listApiTokens(userId: string) {
  return db.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function revokeApiToken(userId: string, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const result = await tx.apiToken.deleteMany({ where: { id, userId } });
    if (result.count) await writeAudit(tx, { actorId: userId, action: 'credential.revoked', targetType: 'apiToken', targetId: id });
  });
}

export async function verifyApiTokenContext(authHeader: string | null) {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  if (!token) return null;

  const record = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true, installation: true },
  });
  if (!record) return null;

  const now = new Date();
  if (record.user.status === 'suspended' || (record.expiresAt && record.expiresAt <= now)) return null;
  if (record.installationId && (!record.installation || record.installation.status !== 'active'
    || record.installation.userId !== record.userId || record.installation.toolkitId !== record.toolkitId)) return null;
  if (record.toolkitId) {
    const allowed = await db.toolkit.findFirst({ where: {
      id: record.toolkitId, enabled: true,
      workspace: { status: 'active', OR: [{ ownerId: record.userId }, { members: { some: { userId: record.userId } } }] },
    }, select: { id: true } });
    if (!allowed) return null;
  }
  const used = await db.apiToken.updateMany({
    where: { id: record.id, user: { status: { not: 'suspended' } },
      ...(record.installationId ? { installation: { is: { id: record.installationId, status: 'active' } } } : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    data: { lastUsedAt: now },
  });
  if (used.count !== 1) return null;
  if (record.installationId) await db.toolkitInstallation.updateMany({
    where: { id: record.installationId, status: 'active' }, data: { lastUsedAt: now },
  });
  return {
    user: record.user,
    token: {
      id: record.id,
      toolkitId: record.toolkitId,
      installationId: record.installationId,
    },
  };
}

export async function verifyApiToken(authHeader: string | null) {
  const context = await verifyApiTokenContext(authHeader);
  // User-only consumers are account-level; scoped consumers must keep context.
  return context && !context.token.toolkitId ? context.user : null;
}
