'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  startProcess,
  stopProcess,
  restartProcess,
  killProcess,
} from '@/lib/process/supervisor';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

async function deploymentInWorkspace(deploymentId: string, workspaceId: string) {
  return db.deployment.findFirst({
    where: { id: deploymentId, workspaceId },
    include: { server: { select: { name: true } } },
  });
}

export async function deployServerAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const serverId = String(formData.get('serverId') ?? '');
  if (!slug || !serverId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const server = await db.server.findUnique({
    where: { id: serverId },
    select: { name: true },
  });
  const dep = await db.deployment.upsert({
    where: { workspaceId_serverId: { workspaceId: ctx.ws.id, serverId } },
    update: {},
    create: { workspaceId: ctx.ws.id, serverId, status: 'provisioning' },
  });
  await startProcess(dep.id, server?.name ?? 'mcp');

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/new`);
}

export async function removeDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  killProcess(deploymentId);
  await db.deployment.deleteMany({
    where: { id: deploymentId, workspaceId: ctx.ws.id },
  });
  revalidatePath(`/app/${slug}/mcp`);
}

export async function startDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await startProcess(dep.id, dep.server.name);
  revalidatePath(`/app/${slug}/mcp`);
}

export async function stopDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await stopProcess(deploymentId);
  revalidatePath(`/app/${slug}/mcp`);
}

export async function restartDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await restartProcess(dep.id, dep.server.name);
  revalidatePath(`/app/${slug}/mcp`);
}

export async function installSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const skillId = String(formData.get('skillId') ?? '');
  if (!slug || !skillId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  await db.installedSkill.upsert({
    where: { workspaceId_skillId: { workspaceId: ctx.ws.id, skillId } },
    update: {},
    create: { workspaceId: ctx.ws.id, skillId },
  });
  revalidatePath(`/app/${slug}/skills`);
  revalidatePath(`/app/${slug}/skills/new`);
}

export async function uninstallSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  if (!slug || !installId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  await db.installedSkill.deleteMany({
    where: { id: installId, workspaceId: ctx.ws.id },
  });
  revalidatePath(`/app/${slug}/skills`);
}

export async function renameWorkspaceAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  if (!slug || !name) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  await db.workspace.update({ where: { id: ctx.ws.id }, data: { name } });
  revalidatePath(`/app/${slug}`, 'layout');
}

export async function deleteWorkspaceAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || ctx.ws.ownerId !== ctx.user.id) return;

  await db.workspace.delete({ where: { id: ctx.ws.id } });
  redirect('/app');
}
