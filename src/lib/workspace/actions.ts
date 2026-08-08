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
import { removeDeploymentContainer } from '@/lib/process/deployment-runtime-container';
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
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
import { encryptSecretText } from '@/lib/security/secrets';
import {
  parseRuntimeTextFiles,
  runtimeFilePathKey,
  type ValidRuntimeTextFile,
} from '@/lib/workspace/runtime-files';
import { removeDeploymentConfigVolume } from '@/lib/process/deployment-config-volume';

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
    include: { server: { select: { name: true, slug: true } } },
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
    select: { slug: true, name: true, installCfg: true, verifiedAt: true },
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
  revalidatePath(`/app/${slug}/market/mcp`);
  revalidatePath(`/app/${slug}/market/mcp/${server.slug}`);
}

export async function deployCustomServerAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  let parsed;
  let runtimeFiles: ValidRuntimeTextFile[];
  try {
    parsed = parseCustomMcpInput({
      // New custom deployments are deliberately JSON-only. Keep legacy source
      // parsing for catalog recipes and existing deployment configuration.
      source: 'config',
      config: String(formData.get('config') ?? ''),
      network: String(formData.get('network') ?? 'isolated'),
    });
    runtimeFiles = parseRuntimeTextFiles(formData.get('runtimeFiles'));
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
      ...(runtimeFiles.length
        ? {
            configFiles: {
              create: runtimeFiles.map((file) => ({
                path: file.path,
                pathKey: runtimeFilePathKey(file.path),
                encryptedContent: encryptSecretText(file.content) as Prisma.InputJsonValue,
                size: file.size,
              })),
            },
          }
        : {}),
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
const MAX_DEPLOYMENT_NAME_LENGTH = 80;

function deploymentName(value: FormDataEntryValue | null): string {
  return String(value ?? '').trim().slice(0, MAX_DEPLOYMENT_NAME_LENGTH);
}

function cloneInstallCfg(
  value: Prisma.JsonValue,
  copyEnvironmentVariables: boolean,
): Prisma.InputJsonValue | undefined {
  if (value === null) return undefined;
  if (
    copyEnvironmentVariables
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return value as Prisma.InputJsonValue;
  }

  const configuration = { ...value };
  delete configuration.env;
  return configuration as Prisma.InputJsonValue;
}

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

export async function renameDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const name = deploymentName(formData.get('name'));
  if (!slug || !deploymentId || !name) return;

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const deployment = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!deployment) return;

  await db.deployment.update({
    where: { id: deployment.id },
    data: { name },
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deployment.id}`);
}

export async function cloneDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;

  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const source = await deploymentInWorkspace(deploymentId, ctx.ws.id);
  if (!source) return;

  const defaultName = `${deploymentLabel(source).name
    .slice(0, MAX_DEPLOYMENT_NAME_LENGTH - 5)
    .trimEnd()} Copy`;
  const nameEntry = formData.get('name');
  const name = nameEntry === null ? defaultName : deploymentName(nameEntry);
  if (!name) return;

  // The form submits a hidden `false` plus a checked `true`. Calls that omit
  // the field retain the secure in-workspace default of copying the complete
  // runtime configuration, including environment variables.
  const copyEnvironmentEntries = formData.getAll('copyEnvironmentVariables').map(String);
  const copyEnvironmentVariables = copyEnvironmentEntries.length === 0
    || copyEnvironmentEntries.includes('true');
  // Runtime files can contain credentials just like environment variables.
  // A clone stays inside the same authorized workspace and mirrors the
  // existing default of copying runtime configuration, but users can opt out
  // explicitly from the clone form.
  const copyRuntimeFileEntries = formData.getAll('copyRuntimeFiles').map(String);
  const copyRuntimeFiles = copyRuntimeFileEntries.length === 0
    || copyRuntimeFileEntries.includes('true');
  const configFiles = copyRuntimeFiles
    ? await db.deploymentConfigFile.findMany({
        where: { deploymentId: source.id },
        select: {
          path: true,
          pathKey: true,
          encryptedContent: true,
          size: true,
        },
      })
    : [];

  const cloned = await db.deployment.create({
    data: {
      workspaceId: ctx.ws.id,
      // Catalog deployments are unique per workspace. A clone is deliberately
      // detached from that directory identity so it can run independently.
      serverId: null,
      name,
      source: source.source,
      sourceRef: source.sourceRef,
      installCfg: cloneInstallCfg(source.installCfg, copyEnvironmentVariables),
      status: 'provisioning',
      mcpToolExposure: source.mcpToolExposure,
      mcpAllowedTools: source.mcpAllowedTools,
      ...(configFiles.length
        ? {
            configFiles: {
              create: configFiles.map((file) => ({
                path: file.path,
                pathKey: file.pathKey,
                // The ciphertext is copied directly. Runtime file plaintext
                // is never read merely to clone a deployment.
                encryptedContent: file.encryptedContent as Prisma.InputJsonValue,
                size: file.size,
              })),
            },
          }
        : {}),
    },
    include: { server: { select: { name: true } } },
  });

  await startProcess(cloned.id, resolveSpawnSpec(cloned), {
    awaitReady: false,
    workspaceId: ctx.ws.id,
  });
  revalidatePath(`/app/${slug}/mcp`);
  redirect(`/app/${slug}/mcp/${cloned.id}`);
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
  if (dep.source) {
    // A failed Docker bridge can leave its named runtime container alive after
    // its local supervisor exits. Remove it before its read-only config volume.
    await removeDeploymentContainer(dep.id);
    // Clean a stale named volume even if the final file was deleted just before
    // a failed restart. Builtin deployments have no container volume at all.
    await removeDeploymentConfigVolume(dep.id);
  }
  await db.deployment.deleteMany({
    where: { id: dep.id, workspaceId: ctx.ws.id },
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/market/mcp`);
  if (dep.server?.slug) {
    revalidatePath(`/app/${slug}/market/mcp/${dep.server.slug}`);
  }
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

  // The workspace market exposes only administrator-curated skills. Recheck
  // the boundary in the action so a forged form cannot install a hidden row.
  const skill = await db.skill.findFirst({
    where: { id: skillId, curated: true },
    select: { slug: true },
  });
  if (!skill) return;

  await db.installedSkill.upsert({
    where: { workspaceId_skillId: { workspaceId: ctx.ws.id, skillId } },
    update: {},
    create: { workspaceId: ctx.ws.id, skillId },
  });
  revalidatePath(`/app/${slug}/skills`);
  revalidatePath(`/app/${slug}/market/skills`);
  revalidatePath(`/app/${slug}/market/skills/${skill.slug}`);
}

export async function uninstallSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  if (!slug || !installId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const installed = await db.installedSkill.findFirst({
    where: { id: installId, workspaceId: ctx.ws.id },
    select: { skill: { select: { slug: true } } },
  });
  if (!installed) return;

  await db.installedSkill.deleteMany({
    where: { id: installId, workspaceId: ctx.ws.id },
  });
  revalidatePath(`/app/${slug}/skills`);
  revalidatePath(`/app/${slug}/market/skills`);
  if (installed.skill?.slug) {
    revalidatePath(`/app/${slug}/market/skills/${installed.skill.slug}`);
  }
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
