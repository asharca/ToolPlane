// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  generateToken,
  hashToken,
  tokenPrefix,
  TOKEN_PREFIX,
} from '@/lib/auth/token-format';

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
