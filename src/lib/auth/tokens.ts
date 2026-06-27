import 'server-only';
import { db } from '@/lib/db';
import { generateToken, hashToken, tokenPrefix } from './token-format';

export { generateToken, hashToken, tokenPrefix } from './token-format';

export async function createApiToken(userId: string, name: string) {
  const token = generateToken();
  const record = await db.apiToken.create({
    data: {
      userId,
      name: name.trim() || 'Default token',
      prefix: tokenPrefix(token),
      tokenHash: hashToken(token),
    },
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
  await db.apiToken.deleteMany({ where: { id, userId } });
}

export async function verifyApiToken(authHeader: string | null) {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  if (!token) return null;

  const record = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!record) return null;

  await db.apiToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  if (record.user.status === 'suspended') return null;
  return record.user;
}
