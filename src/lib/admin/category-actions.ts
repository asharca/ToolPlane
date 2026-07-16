'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createCategory, deleteCategory } from '@/lib/admin/categories';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function createCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
  if (!name || !SLUG_RE.test(slug)) return { error: t('errorInvalidCategory') };
  try {
    await createCategory(slug, name);
  } catch {
    return { error: t('errorCategoryExists') };
  }
  revalidatePath('/admin/categories');
  return { ok: true };
}

export async function deleteCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  try {
    await deleteCategory(String(formData.get('categoryId') ?? ''));
  } catch (e) {
    return { error: e instanceof Error && /not empty/i.test(e.message) ? t('errorCategoryNotEmpty') : t('errorActionFailed') };
  }
  revalidatePath('/admin/categories');
  return { ok: true };
}
