'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  rejectMarketRelease,
} from '@/lib/market/skills';
import { approveResourceMarketRelease } from '@/lib/market/resources';
import type { AdminActionState } from '@/lib/admin/user-actions';

type ReviewRelease = typeof approveResourceMarketRelease;

function errorKey(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'release_not_found') return 'errorMarketReleaseNotPending' as const;
  if (code === 'invalid_manifest') return 'errorInvalidMarketRelease' as const;
  if (code === 'invalid_categories') return 'errorInvalidMarketCategories' as const;
  return 'errorMarketReleaseReviewFailed' as const;
}

async function reviewMarketRelease(
  review: ReviewRelease,
  formData: FormData,
  confirmationRequired = false,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  if (confirmationRequired && formData.get('reviewConfirmed') !== 'yes') {
    return { error: t('errorMarketReleaseReviewConfirmationRequired') };
  }
  const listingId = String(formData.get('listingId') ?? '').trim();
  const releaseId = String(formData.get('releaseId') ?? '').trim();
  if (!listingId || !releaseId) return { error: t('errorMarketReleaseNotPending') };
  const categoryIds = formData.getAll('categoryIds').map(String).filter(Boolean);
  if (confirmationRequired && categoryIds.length === 0) {
    return { error: t('errorMarketCategoryRequired') };
  }

  try {
    await review({
      listingId,
      releaseId,
      reviewedById: admin.id,
      reviewNote: String(formData.get('reviewNote') ?? '').trim().slice(0, 4_000) || null,
      ...(confirmationRequired ? { categoryIds } : {}),
    });
  } catch (error) {
    return { error: t(errorKey(error)) };
  }

  revalidatePath('/admin/market');
  revalidatePath('/app/[workspace]/market', 'layout');
  revalidatePath('/categories');
  revalidatePath('/categories/[slug]', 'page');
  return { ok: true };
}

export async function approveMarketReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return reviewMarketRelease(approveResourceMarketRelease, formData, true);
}

export async function rejectMarketReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return reviewMarketRelease(rejectMarketRelease, formData);
}
