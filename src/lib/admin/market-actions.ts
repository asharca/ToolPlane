'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, updateDirectorySkill, deleteDirectorySkill,
} from '@/lib/admin/market';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const nul = (v: string) => (v === '' ? null : v);
const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const ids = (fd: FormData) => fd.getAll('categoryIds').map((v) => String(v));

export async function createServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectoryServer({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
      isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A server with that slug already exists.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function updateServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectoryServer(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
    isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
  });
  revalidatePath('/admin/servers');
  revalidatePath(`/admin/servers/${id}/edit`);
  return {};
}

export async function deleteServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectoryServer(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function createSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectorySkill({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A skill with that slug already exists.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

export async function updateSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectorySkill(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
  });
  revalidatePath('/admin/skills');
  revalidatePath(`/admin/skills/${id}/edit`);
  return {};
}

export async function deleteSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectorySkill(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}
