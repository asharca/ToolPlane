'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { createCategory, deleteCategory } from '@/lib/admin/categories';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function createCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
  if (!name || !SLUG_RE.test(slug)) return { error: 'Provide a name and a valid slug (a-z0-9-).' };
  try {
    await createCategory(slug, name);
  } catch {
    return { error: 'A category with that slug already exists.' };
  }
  revalidatePath('/admin/categories');
  return {};
}

export async function deleteCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteCategory(String(formData.get('categoryId') ?? ''));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/categories');
  return {};
}
