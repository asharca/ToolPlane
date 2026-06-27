import 'server-only';
import { cache } from 'react';
import { db } from '@/lib/db';
import { getSessionUserId } from './session';
import { activeUserOrNull } from './admin-policy';

export const getCurrentUser = cache(async () => {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true, role: true, status: true },
  });
  return activeUserOrNull(user);
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
