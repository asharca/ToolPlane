'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth/session';
import type { Locale } from '@/i18n/routing';

export async function setLocale(locale: Locale): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set('NEXT_LOCALE', locale, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });

  const userId = await getSessionUserId();
  if (userId) {
    await db.user.update({ where: { id: userId }, data: { locale } });
  }

  revalidatePath('/', 'layout');
}
