'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  AUTO_TIME_ZONE_VALUE,
  normalizeTimeZone,
} from '@/lib/timezone';

export type TimeZonePreferenceState = {
  error?: 'invalidTimeZone' | 'unauthorized';
  savedAt?: number;
};

export async function syncDetectedTimeZone(value: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;

  const timeZone = normalizeTimeZone(value);
  if (!timeZone || timeZone === user.detectedTimeZone) return false;

  const result = await db.user.updateMany({
    where: { id: user.id },
    data: { detectedTimeZone: timeZone },
  });
  if (result.count === 0) return false;

  revalidatePath('/', 'layout');
  return true;
}

export async function updateTimeZonePreference(
  _previous: TimeZonePreferenceState,
  formData: FormData,
): Promise<TimeZonePreferenceState> {
  const user = await getCurrentUser();
  if (!user) return { error: 'unauthorized' };

  const selected = String(formData.get('timeZone') ?? '');
  const automatic = selected === AUTO_TIME_ZONE_VALUE;
  const timeZoneOverride = automatic ? null : normalizeTimeZone(selected);
  if (!automatic && !timeZoneOverride) return { error: 'invalidTimeZone' };

  const detectedTimeZone = automatic
    ? normalizeTimeZone(formData.get('detectedTimeZone'))
    : null;
  const result = await db.user.updateMany({
    where: { id: user.id },
    data: {
      timeZoneOverride,
      ...(detectedTimeZone ? { detectedTimeZone } : {}),
    },
  });
  if (result.count === 0) return { error: 'unauthorized' };

  revalidatePath('/', 'layout');
  return { savedAt: Date.now() };
}
