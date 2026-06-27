'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { deleteManagedWorkspace } from '@/lib/admin/workspaces';
import type { AdminActionState } from '@/lib/admin/user-actions';

export async function deleteWorkspaceAdminAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (confirm !== slug) return { error: 'Type the slug to confirm.' };
  await deleteManagedWorkspace(workspaceId);
  revalidatePath('/admin/workspaces');
  return {};
}
