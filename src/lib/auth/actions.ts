'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { after } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from './password';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from './password-policy';
import { createSession, clearSession, getSessionUserId } from './session';
import { createApiToken, revokeApiToken } from './tokens';
import { safeRelativePath } from './safe-redirect';
import { reconcileAdminRole } from './admin';
import { normalizeTimeZone } from '@/lib/timezone';
import { requestPasswordReset, resetPasswordWithToken } from './password-reset';
import { allowPasswordResetRequest } from './request-rate-limit';

export type AuthState = { error?: string; success?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 320;
const NAME_MAX_LENGTH = 160;
const RESET_TOKEN_MAX_LENGTH = 128;

function boundedText(formData: FormData, name: string, maxLength: number): string | null {
  const value = formData.get(name);
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function normalizedEmail(formData: FormData): string {
  return boundedText(formData, 'email', EMAIL_MAX_LENGTH)?.trim().toLowerCase() ?? '';
}

export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const t = await getTranslations('auth');
  const email = normalizedEmail(formData);
  const password = boundedText(formData, 'password', PASSWORD_MAX_LENGTH);
  const rawName = boundedText(formData, 'name', NAME_MAX_LENGTH);
  const name = rawName?.trim() ?? '';
  const detectedTimeZone = normalizeTimeZone(formData.get('detectedTimeZone'));

  if (!EMAIL_RE.test(email)) return { error: t('invalidEmail') };
  if (rawName === null) return { error: t('nameTooLong', { max: NAME_MAX_LENGTH }) };
  if (password === null) {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }
  const passwordError = validatePassword(password);
  if (passwordError === 'too_short') {
    return { error: t('passwordTooShort', { min: PASSWORD_MIN_LENGTH }) };
  }
  if (passwordError === 'too_long') {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { error: t('emailAlreadyExists') };

  const user = await db.user.create({
    data: {
      email,
      name: name || null,
      passwordHash: await hashPassword(password),
      detectedTimeZone,
    },
  });
  await createSession(user.id, user.sessionVersion);
  await reconcileAdminRole(user);
  redirect(safeRelativePath(formData.get('next')) ?? '/app');
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const t = await getTranslations('auth');
  const email = normalizedEmail(formData);
  const password = boundedText(formData, 'password', PASSWORD_MAX_LENGTH);
  const detectedTimeZone = normalizeTimeZone(formData.get('detectedTimeZone'));

  if (!EMAIL_RE.test(email) || password === null) return { error: t('invalidCredentials') };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    return { error: t('invalidCredentials') };

  if (user.status === 'suspended') return { error: t('accountSuspended') };

  await createSession(user.id, user.sessionVersion);
  await reconcileAdminRole(user);

  if (detectedTimeZone && detectedTimeZone !== user.detectedTimeZone) {
    await db.user.updateMany({
      where: { id: user.id },
      data: { detectedTimeZone },
    });
  }

  // Restore locale preference across devices
  if (user.locale && user.locale !== 'en') {
    const cookieStore = await cookies();
    cookieStore.set('NEXT_LOCALE', user.locale, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  redirect(safeRelativePath(formData.get('next')) ?? '/app');
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/');
}

export async function forgotPasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const t = await getTranslations('auth');
  const email = normalizedEmail(formData);

  // Always return the same result so the form cannot be used to enumerate users.
  if (EMAIL_RE.test(email)) {
    const requestHeaders = await headers();
    if (allowPasswordResetRequest(requestHeaders, email)) {
      after(async () => {
        try {
          await requestPasswordReset(email);
        } catch (error) {
          console.error(
            'Unable to process password-reset request',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
      });
    }
  }
  return { success: t('forgotPasswordSent') };
}

export async function resetPasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const t = await getTranslations('auth');
  const token = boundedText(formData, 'token', RESET_TOKEN_MAX_LENGTH) ?? '';
  const password = boundedText(formData, 'password', PASSWORD_MAX_LENGTH);
  const confirmation = boundedText(formData, 'passwordConfirmation', PASSWORD_MAX_LENGTH);
  if (password === null || confirmation === null) {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }
  if (password !== confirmation) return { error: t('passwordMismatch') };

  const passwordError = validatePassword(password);
  if (passwordError === 'too_short') {
    return { error: t('passwordTooShort', { min: PASSWORD_MIN_LENGTH }) };
  }
  if (passwordError === 'too_long') {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }

  if (!(await resetPasswordWithToken(token, password))) {
    return { error: t('resetLinkInvalid') };
  }
  await clearSession();
  return { success: t('passwordResetComplete') };
}

export async function changePasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const t = await getTranslations('auth');
  const userId = await getSessionUserId();
  if (!userId) return { error: t('signInRequired') };

  const currentPassword = boundedText(formData, 'currentPassword', PASSWORD_MAX_LENGTH);
  const newPassword = boundedText(formData, 'newPassword', PASSWORD_MAX_LENGTH);
  const confirmation = boundedText(formData, 'passwordConfirmation', PASSWORD_MAX_LENGTH);
  if (currentPassword === null) {
    return { error: t('currentPasswordInvalid') };
  }
  if (newPassword === null || confirmation === null) {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }
  if (newPassword !== confirmation) return { error: t('passwordMismatch') };

  const passwordError = validatePassword(newPassword);
  if (passwordError === 'too_short') {
    return { error: t('passwordTooShort', { min: PASSWORD_MIN_LENGTH }) };
  }
  if (passwordError === 'too_long') {
    return { error: t('passwordTooLong', { max: PASSWORD_MAX_LENGTH }) };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return { error: t('currentPasswordInvalid') };
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    return { error: t('passwordMustChange') };
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await db.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    if (changed.count !== 1) return null;
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
    return tx.user.findUnique({
      where: { id: user.id },
      select: { id: true, sessionVersion: true },
    });
  });
  if (!updated) return { error: t('currentPasswordInvalid') };
  await createSession(updated.id, updated.sessionVersion);
  return { success: t('passwordChanged') };
}

export type TokenState = { error?: string; token?: string };

export async function createTokenAction(
  _prev: TokenState,
  formData: FormData,
): Promise<TokenState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: 'You must be signed in.' };

  const name = String(formData.get('name') ?? '').trim();
  const { token } = await createApiToken(userId, name);
  revalidatePath(`/app/${String(formData.get('workspace') ?? '')}/settings/tokens`);
  return { token };
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) return;
  const id = String(formData.get('id') ?? '');
  if (id) await revokeApiToken(userId, id);
  revalidatePath(`/app/${String(formData.get('workspace') ?? '')}/settings/tokens`);
}
