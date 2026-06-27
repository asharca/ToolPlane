'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { setUserRole, setUserStatus, deleteManagedUser } from '@/lib/admin/users';

export type AdminActionState = { error?: string };

export async function setUserRoleAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '') === 'admin' ? 'admin' : 'user';
  try {
    await setUserRole(admin.id, userId, role);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  return {};
}

export async function setUserStatusAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const status = String(formData.get('status') ?? '') === 'suspended' ? 'suspended' : 'active';
  try {
    await setUserStatus(admin.id, userId, status);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  return {};
}

export async function deleteUserAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const email = String(formData.get('email') ?? '');
  if (confirm !== email) return { error: 'Type the email to confirm deletion.' };
  try {
    await deleteManagedUser(admin.id, userId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  return {};
}
