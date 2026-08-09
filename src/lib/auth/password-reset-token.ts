import { createHash, randomBytes } from 'node:crypto';

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_COOLDOWN_MS = 2 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isPasswordResetToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function passwordResetExpiry(now = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
}
