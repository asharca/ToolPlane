import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'sk_user_';

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(20).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 8);
}
