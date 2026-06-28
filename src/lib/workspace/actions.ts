'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  startProcess,
  stopProcess,
  restartProcess,
  killProcess,
} from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';
import { parseServerRecipe, recipeToDeploymentData } from '@/lib/workspace/server-recipe';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

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
    select: { name: true, installCfg: true, verifiedAt: true },
  });
  if (!server) return;
  // Only deploy a catalog server an admin has wired up AND validated. Without a
  // verified recipe the entry is not deployable (the browse UI hides "Add").
  const recipe = parseServerRecipe(server.installCfg);
  if (!recipe || !server.verifiedAt) return;

  const data = recipeToDeploymentData(recipe);
  // `update: {}` on re-deploy intentionally preserves the deployment's existing
  // installCfg — so a user's filled-in env values are not wiped by the recipe's
  // empty seeds. Only the first create seeds from the recipe.
  const dep = await db.deployment.upsert({
    where: { workspaceId_serverId: { workspaceId: ctx.ws.id, serverId } },
    update: {},
    create: {
      workspaceId: ctx.ws.id,
      serverId,
      status: 'provisioning',
      source: data.source,
      sourceRef: data.sourceRef,
      installCfg: data.installCfg as Prisma.InputJsonValue,
    },
  });
  await startProcess(
    dep.id,
    resolveSpawnSpec({
      serverId: dep.serverId,
      server: { name: server.name },
      name: dep.name,
      source: dep.source,
      sourceRef: dep.sourceRef,
      installCfg: dep.installCfg,
    }),
  );

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/new`);
}

export async function deployCustomServerAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  let parsed;
  try {
    parsed = parseCustomMcpInput({
      source: String(formData.get('source') ?? 'npm'),
      ref: String(formData.get('ref') ?? ''),
      name: String(formData.get('name') ?? ''),
      startCommand: String(formData.get('startCommand') ?? ''),
    });
  } catch {
    return;
  }

  const dep = await db.deployment.create({
    data: {
      workspaceId: ctx.ws.id,
      serverId: null,
      name: parsed.name,
      source: parsed.source,
      sourceRef: parsed.ref,
      installCfg: parsed.installCfg ?? undefined,
      status: 'provisioning',
    },
  });

  await startProcess(
    dep.id,
    resolveSpawnSpec({
      serverId: null,
      server: null,
      name: dep.name,
      source: dep.source,
      sourceRef: dep.sourceRef,
      installCfg: dep.installCfg,
    }),
  );

  revalidatePath(`/app/${slug}/mcp`);
  redirect(`/app/${slug}/mcp/${dep.id}`);
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function setDeploymentEnvAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ctx.ws.id },
    select: { id: true, installCfg: true },
  });
  if (!dep) return;

  const env: Record<string, string> = {};
  try {
    const rows = JSON.parse(String(formData.get('env') ?? '[]')) as { key: string; value: string }[];
    for (const r of rows) if (r.key && ENV_KEY.test(r.key)) env[r.key] = String(r.value ?? '');
  } catch {
    return;
  }

  const next: Record<string, unknown> = { ...((dep.installCfg ?? {}) as Record<string, unknown>), env };
  // `--network none` toggle: an unchecked checkbox submits nothing → isolated.
  if (String(formData.get('network') ?? '') === 'none') next.network = 'none';
  else delete next.network;

  await db.deployment.update({
    where: { id: deploymentId },
    data: { installCfg: next as Prisma.InputJsonValue },
  });
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
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
  // Redirect to the list: this action also fires from the deployment detail
  // page, which would otherwise re-render against the now-deleted row → 404.
  redirect(`/app/${slug}/mcp`);
}

export async function startDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await startProcess(dep.id, resolveSpawnSpec(dep));
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

  await restartProcess(dep.id, resolveSpawnSpec(dep));
  revalidatePath(`/app/${slug}/mcp`);
}

// Rebuild = tear the process down and spawn it fresh, re-fetching the package /
// image (vs. Restart, which reuses the cached one). Stays on the detail page.
export async function rebuildDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await restartProcess(dep.id, resolveSpawnSpec(dep, true));
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
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

  await killWorkspaceProcesses(ctx.ws.id);

  await db.workspace.delete({ where: { id: ctx.ws.id } });
  redirect('/app');
}

function slugifyName(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

export async function createWorkspaceAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;
  const name = String(formData.get('name') ?? '').trim() || 'New workspace';

  const base = slugifyName(name);
  let slug = base;
  for (let i = 1; await db.workspace.findUnique({ where: { slug } }); i += 1) {
    slug = `${base}-${i}`;
  }

  const ws = await db.workspace.create({
    data: {
      slug,
      name,
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'owner' } },
    },
  });
  redirect(`/app/${ws.slug}/mcp`);
}
