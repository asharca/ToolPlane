'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

async function toolkitInWorkspace(toolkitSlug: string, workspaceId: string) {
  return db.toolkit.findFirst({ where: { slug: toolkitSlug, workspaceId } });
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'toolkit';
}

export async function createToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'New toolkit';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const base = slugify(name);
  let toolkitSlug = base;
  for (
    let i = 1;
    await db.toolkit.findFirst({
      where: { workspaceId: ctx.ws.id, slug: toolkitSlug },
    });
    i += 1
  ) {
    toolkitSlug = `${base}-${i}`;
  }

  await db.toolkit.create({
    data: { workspaceId: ctx.ws.id, name, slug: toolkitSlug },
  });
  revalidatePath(`/app/${slug}/toolkits`);
  redirect(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function deleteToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (toolkitSlug === 'me') return; // default toolkit is not deletable
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkit.delete({ where: { id: tk.id } });
  revalidatePath(`/app/${slug}/toolkits`);
  redirect(`/app/${slug}/toolkits`);
}

export async function setToolkitVisibilityAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const visibility =
    String(formData.get('visibility') ?? '') === 'public' ? 'public' : 'private';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkit.update({ where: { id: tk.id }, data: { visibility } });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function addServerToToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;
  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ctx.ws.id },
    select: { id: true },
  });
  if (!dep) return;

  await db.toolkitServer.upsert({
    where: { toolkitId_deploymentId: { toolkitId: tk.id, deploymentId } },
    update: {},
    create: { toolkitId: tk.id, deploymentId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function removeServerFromToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkitServer.deleteMany({
    where: { toolkitId: tk.id, deploymentId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function addSkillToToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const installedSkillId = String(formData.get('installedSkillId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;
  const inst = await db.installedSkill.findFirst({
    where: { id: installedSkillId, workspaceId: ctx.ws.id },
    select: { id: true },
  });
  if (!inst) return;

  await db.toolkitSkill.upsert({
    where: {
      toolkitId_installedSkillId: { toolkitId: tk.id, installedSkillId },
    },
    update: {},
    create: { toolkitId: tk.id, installedSkillId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function removeSkillFromToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const installedSkillId = String(formData.get('installedSkillId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkitSkill.deleteMany({
    where: { toolkitId: tk.id, installedSkillId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}
