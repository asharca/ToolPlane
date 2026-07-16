'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { deleteManagedWorkspace } from '@/lib/admin/workspaces';
import type { AdminActionState } from '@/lib/admin/user-actions';

export async function deleteWorkspaceAdminAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (confirm !== slug) return { error: t('errorTypeSlug') };
  try {
    await deleteManagedWorkspace(workspaceId);
  } catch {
    return { error: t('errorActionFailed') };
  }
  revalidatePath('/admin/workspaces');
  redirect('/admin/workspaces');
}
