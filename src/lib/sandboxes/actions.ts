'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { startProcess, stopProcess, restartProcess, killProcess } from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import {
  DEFAULT_SANDBOX_IMAGE,
  removeDockerSandboxRuntime,
  sandboxVolumeName,
} from './runtime';
import {
  connectorFromConfig,
  connectorSourceRef,
  createConnectorConfig,
  type SandboxConnectorConfig,
} from './connector';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'sandbox';
}

async function uniqueSlug(workspaceId: string, name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let i = 1; await db.sandbox.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${base}-${i}`;
  }
  return slug;
}

async function sandboxInWorkspace(sandboxId: string, workspaceId: string) {
  return db.sandbox.findFirst({ where: { id: sandboxId, workspaceId }, include: { deployment: true } });
}

function installCfgForSandbox(sandbox: {
  id: string;
  kind: string;
  image: string | null;
  network: string;
  config: Prisma.JsonValue | null;
}): Prisma.InputJsonValue {
  const connector = connectorFromConfig(sandbox.config);
  return {
    sandboxId: sandbox.id,
    kind: sandbox.kind,
    image: sandbox.image,
    network: sandbox.network,
    volumeName: sandboxVolumeName(sandbox.id),
    connector: connector ?? undefined,
  };
}

export async function createSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'Linux sandbox';
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const kind = String(formData.get('kind') ?? 'docker') === 'connector' ? 'connector' : 'docker';
  const sandboxSlug = await uniqueSlug(ctx.ws.id, name);
  const network = String(formData.get('network') ?? 'isolated') === 'none' ? 'none' : 'isolated';
  const image = kind === 'docker'
    ? String(formData.get('image') ?? '').trim() || DEFAULT_SANDBOX_IMAGE
    : null;
  const connectorBundle = kind === 'connector'
    ? createConnectorConfig({
        serverUrl: String(formData.get('connectorServerUrl') ?? ''),
        remoteRoot: String(formData.get('connectorRemoteRoot') ?? '').trim(),
      })
    : undefined;
  const connectorConfig: SandboxConnectorConfig | undefined = connectorBundle?.config;

  const dep = await db.deployment.create({
    data: {
      workspaceId: ctx.ws.id,
      serverId: null,
      name: `Sandbox: ${name}`,
      source: 'sandbox',
      sourceRef: kind === 'docker'
        ? image
        : connectorConfig ? connectorSourceRef(connectorConfig) : 'connector://missing',
      status: kind === 'connector' ? 'stopped' : 'provisioning',
    },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId: ctx.ws.id,
      deploymentId: dep.id,
      name,
      slug: sandboxSlug,
      kind,
      image,
      network,
      config: connectorConfig ? { connector: connectorConfig } : undefined,
    },
  });
  const installCfg = installCfgForSandbox(sandbox);
  const updated = await db.deployment.update({
    where: { id: dep.id },
    data: { installCfg },
  });

  if (kind === 'docker') {
    await startProcess(updated.id, resolveSpawnSpec(updated));
  }
  revalidatePath(`/app/${slug}/sandboxes`);
  const tokenQuery = connectorBundle ? `?token=${encodeURIComponent(connectorBundle.token)}` : '';
  redirect(`/app/${slug}/sandboxes/${sandbox.id}${tokenQuery}`);
}

export async function startSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox) return;
  if (sandbox.kind === 'host' || sandbox.kind === 'ssh') return;
  if (sandbox.kind === 'connector' && !connectorFromConfig(sandbox.config)) return;
  await startProcess(sandbox.deploymentId, resolveSpawnSpec(sandbox.deployment));
  revalidatePath(`/app/${slug}/sandboxes`);
}

export async function stopSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox) return;
  await stopProcess(sandbox.deploymentId);
  revalidatePath(`/app/${slug}/sandboxes`);
}

export async function restartSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox) return;
  if (sandbox.kind === 'host' || sandbox.kind === 'ssh') return;
  if (sandbox.kind === 'connector' && !connectorFromConfig(sandbox.config)) return;
  await restartProcess(sandbox.deploymentId, resolveSpawnSpec(sandbox.deployment));
  revalidatePath(`/app/${slug}/sandboxes`);
}

export async function deleteSandboxAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const sandboxId = String(formData.get('sandboxId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sandboxId) return;
  const sandbox = await sandboxInWorkspace(sandboxId, ctx.ws.id);
  if (!sandbox) return;

  killProcess(sandbox.deploymentId);
  if (sandbox.kind === 'docker') {
    const cfg = (sandbox.deployment.installCfg ?? {}) as { volumeName?: string };
    await removeDockerSandboxRuntime(sandbox.id, cfg.volumeName);
  }
  await db.deployment.deleteMany({
    where: { id: sandbox.deploymentId, workspaceId: ctx.ws.id, source: 'sandbox' },
  });
  revalidatePath(`/app/${slug}/sandboxes`);
}
