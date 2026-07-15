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
  liveStatus,
} from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { listMcpTools, mcpRpc } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';
import {
  EDITABLE_MCP_SOURCES,
  isEditableMcpSource,
  parseCustomMcpInput,
  parseMcpDeploymentConfig,
  serializeMcpDeploymentConfig,
} from '@/lib/workspace/custom-mcp';
import { parseServerRecipe, recipeToDeploymentData } from '@/lib/workspace/server-recipe';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

export type WorkspaceInviteState = { error?: string; message?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

async function deploymentInWorkspace(deploymentId: string, workspaceId: string) {
  return db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId,
      OR: [{ source: null }, { source: { not: 'sandbox' } }],
    },
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
    { awaitReady: false, workspaceId: ctx.ws.id },
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
      config: String(formData.get('config') ?? ''),
      network: String(formData.get('network') ?? 'isolated'),
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
    { awaitReady: false, workspaceId: ctx.ws.id },
  );

  revalidatePath(`/app/${slug}/mcp`);
  redirect(`/app/${slug}/mcp/${dep.id}`);
}

export type McpJsonConfigActionState = {
  error?: 'invalidJsonConfig' | 'notAuthorized' | 'deploymentNotFound' | 'rebuildFailed';
  savedAt?: number;
};

export type McpJsonConfigRevealResult = {
  config?: string;
  error?: 'notAuthorized' | 'deploymentNotFound';
};

export async function revealMcpJsonConfigAction({
  workspace,
  deploymentId,
}: {
  workspace: string;
  deploymentId: string;
}): Promise<McpJsonConfigRevealResult> {
  if (!workspace || !deploymentId) return { error: 'deploymentNotFound' };
  const ctx = await authorizedWorkspace(workspace);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: ctx.ws.id,
      source: { in: [...EDITABLE_MCP_SOURCES] },
    },
    select: { source: true, sourceRef: true, installCfg: true },
  });
  if (!deployment || !isEditableMcpSource(deployment.source)) {
    return { error: 'deploymentNotFound' };
  }
  return { config: serializeMcpDeploymentConfig(deployment) };
}

export async function updateMcpJsonConfigAction(
  _previous: McpJsonConfigActionState,
  formData: FormData,
): Promise<McpJsonConfigActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const config = String(formData.get('config') ?? '');
  const network = formData.get('network');
  if (!slug || !deploymentId || !config.trim()) return { error: 'invalidJsonConfig' };

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: ctx.ws.id,
      source: { in: [...EDITABLE_MCP_SOURCES] },
    },
  });
  if (!deployment || !isEditableMcpSource(deployment.source)) {
    return { error: 'deploymentNotFound' };
  }

  let parsed;
  try {
    parsed = parseMcpDeploymentConfig(
      config,
      deployment.source,
      deployment.name ?? undefined,
      network === null ? undefined : String(network),
    );
  } catch {
    return { error: 'invalidJsonConfig' };
  }
  if (deployment.serverId && parsed.ref !== deployment.sourceRef) {
    return { error: 'invalidJsonConfig' };
  }
  const updated = await db.deployment.update({
    where: { id: deployment.id },
    data: {
      source: parsed.source,
      sourceRef: parsed.ref,
      installCfg: parsed.installCfg as Prisma.InputJsonValue,
      status: 'provisioning',
    },
    include: { server: { select: { name: true } } },
  });

  try {
    await restartProcess(updated.id, resolveSpawnSpec(updated, true), {
      awaitReady: false,
      workspaceId: ctx.ws.id,
    });
  } catch {
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: 'error' },
    });
    revalidatePath(`/app/${slug}/mcp`);
    revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
    return { error: 'rebuildFailed' };
  }

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
  return { savedAt: Date.now() };
}

export type McpToolExposureActionState = {
  error?: 'notAuthorized' | 'deploymentNotFound' | 'invalidToolSelection';
  savedAt?: number;
  revision?: number;
};

const MAX_ALLOWED_MCP_TOOLS = 500;
const MAX_MCP_TOOL_NAME_LENGTH = 256;

function validMcpToolNames(values: FormDataEntryValue[]): string[] | null {
  const names = [...new Set(values.map(String))];
  if (names.length > MAX_ALLOWED_MCP_TOOLS) return null;
  if (names.reduce((total, name) => total + name.length, 0) > 64_000) return null;
  if (names.some((name) => (
    !name
    || name.length > MAX_MCP_TOOL_NAME_LENGTH
    || name.includes('\0')
  ))) return null;
  return names;
}

export async function updateMcpToolExposureAction(
  _previous: McpToolExposureActionState,
  formData: FormData,
): Promise<McpToolExposureActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const mode = String(formData.get('mode') ?? '');
  const rawRevision = Number(formData.get('revision') ?? 0);
  const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
  if (!slug || !deploymentId || (mode !== 'all' && mode !== 'allowlist')) {
    return { error: 'invalidToolSelection' };
  }

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ctx.ws.id },
    select: {
      id: true,
      source: true,
    },
  });
  if (!deployment || deployment.source === 'sandbox') {
    return { error: 'deploymentNotFound' };
  }

  const selected = validMcpToolNames(formData.getAll('toolName'));
  if (!selected) return { error: 'invalidToolSelection' };

  await db.deployment.update({
    where: { id: deployment.id },
    data: {
      mcpToolExposure: mode,
      mcpAllowedTools: mode === 'allowlist' ? selected : [],
    },
  });
  revalidatePath(`/app/${slug}/mcp/${deployment.id}`);
  return { savedAt: Date.now(), revision };
}

export type McpConsoleToolResult = {
  result?: Record<string, unknown>;
  error?: 'notAuthorized' | 'deploymentNotFound' | 'deploymentNotRunning' | 'invalidToolCall' | 'toolCallFailed';
};

export async function runMcpConsoleToolAction(input: {
  workspace: string;
  deploymentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<McpConsoleToolResult> {
  const slug = input.workspace;
  const deploymentId = input.deploymentId;
  const toolName = input.toolName;
  if (!slug || !deploymentId || !toolName || toolName.length > MAX_MCP_TOOL_NAME_LENGTH) {
    return { error: 'invalidToolCall' };
  }
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    return { error: 'invalidToolCall' };
  }
  let requestBody = '';
  try {
    requestBody = JSON.stringify({ name: toolName, arguments: input.arguments });
  } catch {
    return { error: 'invalidToolCall' };
  }
  if (requestBody.length > 16_000) return { error: 'invalidToolCall' };

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'notAuthorized' };
  const deployment = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!deployment) return { error: 'deploymentNotFound' };
  if (liveStatus(deployment.id) !== 'running') return { error: 'deploymentNotRunning' };

  const availableTools = await listMcpTools(deployment.id);
  if (!availableTools.some((tool) => tool.name === toolName)) {
    return { error: 'invalidToolCall' };
  }

  const startedAt = Date.now();
  const result = await mcpRpc(deployment.id, 'tools/call', {
    name: toolName,
    arguments: input.arguments,
  });
  await logRequest({
    workspaceId: ctx.ws.id,
    deploymentId: deployment.id,
    method: 'POST',
    path: `/mcp/${deployment.id}/rpc#tools/call:${toolName}`,
    statusCode: result ? 200 : 502,
    durationMs: Date.now() - startedAt,
    requestBody,
    responseBody: JSON.stringify(result ?? { error: 'unreachable' }).slice(0, 16_000),
  });
  return result ? { result } : { error: 'toolCallFailed' };
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function setDeploymentEnvAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: ctx.ws.id,
      OR: [{ source: null }, { source: { not: 'sandbox' } }],
    },
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

  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await killProcess(dep.id, { preventRestart: true });
  await db.deployment.deleteMany({
    where: { id: dep.id, workspaceId: ctx.ws.id },
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

  await startProcess(dep.id, resolveSpawnSpec(dep), {
    awaitReady: false,
    workspaceId: ctx.ws.id,
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
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
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
}

export async function restartDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!dep) return;

  await restartProcess(dep.id, resolveSpawnSpec(dep), {
    awaitReady: false,
    workspaceId: ctx.ws.id,
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
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

  await restartProcess(dep.id, resolveSpawnSpec(dep, true), {
    awaitReady: false,
    workspaceId: ctx.ws.id,
  });
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

export async function inviteWorkspaceMemberAction(
  _prev: WorkspaceInviteState,
  formData: FormData,
): Promise<WorkspaceInviteState> {
  const slug = String(formData.get('workspace') ?? '');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!slug) return { error: 'Workspace is missing.' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: 'You do not have access to this workspace.' };
  if (ctx.ws.ownerId !== ctx.user.id) {
    return { error: 'Only the workspace owner can invite members.' };
  }

  const invitee = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!invitee) return { error: 'No user with that email exists yet.' };

  const existing = await db.membership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: ctx.ws.id,
        userId: invitee.id,
      },
    },
    select: { id: true },
  });
  if (existing || invitee.id === ctx.ws.ownerId) {
    return { message: `${invitee.email} is already a member.` };
  }

  await db.membership.create({
    data: {
      workspaceId: ctx.ws.id,
      userId: invitee.id,
      role: 'member',
    },
  });

  revalidatePath(`/app/${slug}/members`);
  revalidatePath(`/app/${slug}`, 'layout');
  return { message: `${invitee.email} joined this workspace.` };
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
