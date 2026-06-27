'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getOrCreateDefaultWorkspace } from '@/lib/workspace/queries';
import { upsertInstalledSkill } from '@/lib/skills/install';

// Public-site one-click: install a directory skill into the caller's default
// workspace, then open it in the console.
export async function addSkillToWorkspaceAction(formData: FormData) {
  const user = await getCurrentUser();
  const skillId = String(formData.get('skillId') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/tools/skills/${slug}`)}`);
  if (!skillId) return;
  const ws = await getOrCreateDefaultWorkspace(user.id, user.email);
  const install = await upsertInstalledSkill(ws.id, skillId);
  revalidatePath(`/app/${ws.slug}/skills`);
  redirect(`/app/${ws.slug}/skills/${install.id}`);
}
