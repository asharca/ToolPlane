'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth/session';

export async function addToHubAction(formData: FormData): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) return;
  const serverId = String(formData.get('serverId') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (!serverId) return;

  await db.user.update({
    where: { id: userId },
    data: { hubServers: { connect: { id: serverId } } },
  });
  if (slug) revalidatePath(`/server/${slug}`);
  revalidatePath('/hub');
}

export async function removeFromHubAction(formData: FormData): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) return;
  const serverId = String(formData.get('serverId') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (!serverId) return;

  await db.user.update({
    where: { id: userId },
    data: { hubServers: { disconnect: { id: serverId } } },
  });
  if (slug) revalidatePath(`/server/${slug}`);
  revalidatePath('/hub');
}
