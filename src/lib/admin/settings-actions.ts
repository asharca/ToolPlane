'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import type { AdminActionState } from '@/lib/admin/user-actions';
import { updateSystemSettings } from '@/lib/admin/settings';
import {
  isValidHermesArchiveMaxUploadMiB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';

function parseWholeNumber(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function updateSystemSettingsAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const hermesArchiveMaxUploadMiB = parseWholeNumber(formData, 'hermesArchiveMaxUploadMiB');
  if (!isValidHermesArchiveMaxUploadMiB(hermesArchiveMaxUploadMiB)) {
    return {
      error: t('errorHermesArchiveMaxUploadMiB', {
        min: MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
        max: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
      }),
    };
  }

  try {
    await updateSystemSettings(hermesArchiveMaxUploadMiB);
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}
