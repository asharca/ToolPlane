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

export type AdminSettingsActionState = { ok?: boolean; error?: string };

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
      const raw = String(formData.get('maxAttachmentSizeMb') ?? '').trim();
      const megabytes = Number(raw);
      if (
        !/^\d+$/.test(raw)
        || !Number.isSafeInteger(megabytes)
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
