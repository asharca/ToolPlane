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
    include: { user: true },
  });
  if (!record) return null;

  if (record.user.status === 'suspended') return null;
  await db.apiToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return {
    user: record.user,
    token: {
      id: record.id,
      toolkitId: record.toolkitId,
    },
  };
}

export async function verifyApiToken(authHeader: string | null) {
  return (await verifyApiTokenContext(authHeader))?.user ?? null;
}
