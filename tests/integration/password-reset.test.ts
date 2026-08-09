// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { requestPasswordReset, resetPasswordWithToken } from '@/lib/auth/password-reset';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetExpiry,
} from '@/lib/auth/password-reset-token';

const mail = vi.hoisted(() => ({
  send: vi.fn(async (_input: { to: string; token: string; locale?: string | null }) => {
    void _input;
  }),
}));
vi.mock('@/lib/auth/password-reset-mail', () => ({
  passwordResetEmailConfigured: () => true,
  sendPasswordResetEmail: mail.send,
}));

const email = `password-reset-${Date.now()}@t.dev`;
let userId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword('old-password-value') },
  });
  userId = user.id;
});

afterAll(async () => {
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

beforeEach(() => {
  mail.send.mockClear();
});

describe('password reset requests', () => {
  it('atomically throttles concurrent requests to one active link and one email', async () => {
    await Promise.all(Array.from({ length: 5 }, () => requestPasswordReset(email)));

    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(await db.passwordResetToken.count({ where: { userId } })).toBe(1);
    const token = mail.send.mock.calls[0]?.[0]?.token;
    expect(typeof token).toBe('string');
    const record = await db.passwordResetToken.findUniqueOrThrow({ where: { userId } });
    expect(record.tokenHash).toBe(hashPasswordResetToken(String(token)));
    await db.passwordResetToken.deleteMany({ where: { userId } });
  });
});

describe('password reset consumption', () => {
  it('atomically consumes the link, replaces the password, and invalidates sessions', async () => {
    const token = generatePasswordResetToken();
    await db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashPasswordResetToken(token),
        expiresAt: passwordResetExpiry(),
      },
    });

    const attempts = await Promise.all([
      resetPasswordWithToken(token, 'new-password-value'),
      resetPasswordWithToken(token, 'new-password-value'),
    ]);
    expect(attempts.sort()).toEqual([false, true]);

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword('new-password-value', user.passwordHash)).toBe(true);
    expect(user.sessionVersion).toBe(1);
    expect(await db.passwordResetToken.count({ where: { userId } })).toBe(0);
  });

  it('does not consume an expired link or change the password', async () => {
    const token = generatePasswordResetToken();
    await db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashPasswordResetToken(token),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    expect(await resetPasswordWithToken(token, 'should-not-be-used')).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword('new-password-value', user.passwordHash)).toBe(true);
    expect(user.sessionVersion).toBe(1);
  });
});
