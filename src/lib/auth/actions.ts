'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from './password';
import { createSession, clearSession, getSessionUserId } from './session';
import { createApiToken, revokeApiToken } from './tokens';
import { safeRelativePath } from './safe-redirect';

export type AuthState = { error?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  if (password.length < 8)
    return { error: 'Password must be at least 8 characters.' };

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { error: 'An account with that email already exists.' };

  const user = await db.user.create({
    data: { email, name: name || null, passwordHash: await hashPassword(password) },
  });
  await createSession(user.id);
  redirect(safeRelativePath(formData.get('next')) ?? '/app');
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    return { error: 'Invalid email or password.' };

  await createSession(user.id);
  redirect(safeRelativePath(formData.get('next')) ?? '/app');
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/');
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
