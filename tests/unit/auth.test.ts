// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '@/lib/auth/password-policy';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  isPasswordResetToken,
  PASSWORD_RESET_TTL_MS,
  passwordResetExpiry,
} from '@/lib/auth/password-reset-token';
import {
  passwordResetEmailConfigured,
  passwordResetUrl,
} from '@/lib/auth/password-reset-mail';
import {
  generateToken,
  hashToken,
  tokenPrefix,
  TOKEN_PREFIX,
} from '@/lib/auth/token-format';
import { secureSessionCookie } from '@/lib/auth/session-cookie';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).toContain(':');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts passphrases within the supported length', () => {
    expect(validatePassword('correct horse battery staple')).toBeNull();
  });

  it('bounds password length to avoid weak secrets and expensive oversized inputs', () => {
    expect(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
    expect(validatePassword('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('too_long');
  });
});

describe('password reset token format', () => {
  it('generates opaque 256-bit URL-safe tokens and stores deterministic hashes', () => {
    const token = generatePasswordResetToken();
    expect(isPasswordResetToken(token)).toBe(true);
    expect(hashPasswordResetToken(token)).toHaveLength(64);
    expect(hashPasswordResetToken(token)).toBe(hashPasswordResetToken(token));
    expect(generatePasswordResetToken()).not.toBe(token);
  });

  it('rejects malformed tokens and expires links after one hour', () => {
    expect(isPasswordResetToken('not-a-token')).toBe(false);
    const now = new Date('2026-08-09T08:00:00.000Z');
    expect(passwordResetExpiry(now).getTime() - now.getTime()).toBe(PASSWORD_RESET_TTL_MS);
  });
});

describe('password reset email configuration', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalSmtpUrl = process.env.SMTP_URL;
  const originalSmtpFrom = process.env.SMTP_FROM;

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('NEXT_PUBLIC_APP_URL', originalAppUrl);
    restore('SMTP_URL', originalSmtpUrl);
    restore('SMTP_FROM', originalSmtpFrom);
  });

  it('builds reset links only from the configured public app origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.example/base/path';
    const token = generatePasswordResetToken();
    expect(passwordResetUrl(token)).toBe(
      `https://toolplane.example/app/reset-password?token=${token}`,
    );
  });

  it('requires both an SMTP endpoint and sender before advertising delivery', () => {
    delete process.env.SMTP_URL;
    delete process.env.SMTP_FROM;
    expect(passwordResetEmailConfigured()).toBe(false);
    process.env.SMTP_URL = 'smtp://localhost:1025';
    expect(passwordResetEmailConfigured()).toBe(false);
    process.env.SMTP_FROM = 'ToolPlane <no-reply@example.com>';
    expect(passwordResetEmailConfigured()).toBe(true);
  });
});

describe('session cookie transport', () => {
  it('follows the canonical origin so production Docker remains usable over HTTP', () => {
    expect(secureSessionCookie('https://toolplane.example', 'production')).toBe(true);
    expect(secureSessionCookie('http://localhost:10030', 'production')).toBe(false);
  });

  it('defaults to secure cookies for a production instance with invalid configuration', () => {
    expect(secureSessionCookie('not a URL', 'production')).toBe(true);
    expect(secureSessionCookie(undefined, 'development')).toBe(false);
  });
});

describe('api token format', () => {
  it('generates sk_user_ prefixed tokens of fixed length', () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t.length).toBe(TOKEN_PREFIX.length + 40);
  });

  it('hashes to a deterministic 64-char sha256 hex', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toHaveLength(64);
  });

  it('derives a display prefix of prefix + 8 chars', () => {
    expect(tokenPrefix('sk_user_0123456789abcdef')).toBe('sk_user_01234567');
  });
});
