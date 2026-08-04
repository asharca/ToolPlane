'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resetAgentAttachmentLimit,
  setAgentAttachmentLimitBytes,
} from '@/lib/agents/attachment-limits';
import { updateHermesArchiveSettings } from '@/lib/admin/settings';
import {
  isValidHermesArchiveMaxUploadMiB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';

export type AdminSettingsActionState = { ok?: boolean; error?: string };

function parseWholeNumber(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function updateAgentAttachmentLimitAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');

  try {
    if (String(formData.get('intent') ?? '') === 'reset') {
      await resetAgentAttachmentLimit();
    } else {
      const megabytes = parseWholeNumber(formData, 'maxAttachmentSizeMb');
      if (
        megabytes === null
        || megabytes < MIN_ADMIN_ATTACHMENT_MEGABYTES
        || megabytes > MAX_ADMIN_ATTACHMENT_MEGABYTES
      ) {
        return { error: t('errorInvalidAttachmentLimit', {
          min: MIN_ADMIN_ATTACHMENT_MEGABYTES,
          max: MAX_ADMIN_ATTACHMENT_MEGABYTES,
        }) };
      }
      await setAgentAttachmentLimitBytes(megabytes * 1_000_000);
    }
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}

export async function updateHermesArchiveUploadLimitAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
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
    await updateHermesArchiveSettings(hermesArchiveMaxUploadMiB);
  } catch {
    return { error: t('errorActionFailed') };
  }

  revalidatePath('/admin/settings');
  return { ok: true };
}
