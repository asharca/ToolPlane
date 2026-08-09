import 'server-only';
import { db } from '@/lib/db';
import { hashPassword } from './password';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  isPasswordResetToken,
  PASSWORD_RESET_COOLDOWN_MS,
  passwordResetExpiry,
} from './password-reset-token';
import {
  passwordResetEmailConfigured,
  sendPasswordResetEmail,
} from './password-reset-mail';

export async function requestPasswordReset(email: string): Promise<void> {
  if (!passwordResetEmailConfigured()) return;

  const user = await db.user.findFirst({
    where: { email, status: 'active' },
    select: { id: true, email: true, locale: true },
  });
  if (!user) return;

  const token = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(token);
  const now = new Date();
  const cooldownStart = new Date(now.getTime() - PASSWORD_RESET_COOLDOWN_MS);

  let claimed = false;
  try {
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: passwordResetExpiry(now),
      },
    });
    claimed = true;
  } catch (error) {
    const uniqueConflict =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
    if (!uniqueConflict) throw error;

    const updated = await db.passwordResetToken.updateMany({
      where: { userId: user.id, createdAt: { lte: cooldownStart } },
      data: {
        tokenHash,
        expiresAt: passwordResetExpiry(now),
        createdAt: now,
      },
    });
    claimed = updated.count === 1;
  }
  if (!claimed) return;

  try {
    await sendPasswordResetEmail({
      to: user.email,
      token,
      locale: user.locale,
    });
  } catch (error) {
    await db.passwordResetToken.deleteMany({ where: { tokenHash } });
    console.error(
      'Unable to send password-reset email',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

export async function resetPasswordWithToken(
  token: string,
  password: string,
): Promise<boolean> {
  if (!isPasswordResetToken(token)) return false;

  const tokenHash = hashPasswordResetToken(token);
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  if (!record) return false;

  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.deleteMany({
      where: { tokenHash, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) return false;

    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.deleteMany({ where: { userId: record.userId } });
    return true;
  });
}
