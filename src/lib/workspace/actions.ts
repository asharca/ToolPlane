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
import {
  missingDeploymentRequiredEnvironment,
  missingRequiredEnvironment,
  parseServerRecipe,
  recipeToDeploymentData,
  storedRequiredEnvironment,
} from '@/lib/workspace/server-recipe';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
import { encryptSecretText } from '@/lib/security/secrets';
import {
  parseRuntimeTextFiles,
  runtimeFilePathKey,
  type ValidRuntimeTextFile,
} from '@/lib/workspace/runtime-files';
import { removeDeploymentConfigVolume } from '@/lib/process/deployment-config-volume';
import { runMcpDeploymentOperation } from '@/lib/workspace/mcp-operation';
import { hasMcpToolCatalog, readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';

export type WorkspaceInviteState = { error?: string; message?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPLOYMENT_ENV_VARS = 100;
const MAX_DEPLOYMENT_ENV_VALUE_LENGTH = 16_000;
const MAX_DEPLOYMENT_ENV_LENGTH = 64_000;

function mcpProcessOptions(workspaceId: string, deploymentId: string) {
  return {
    awaitReady: false,
    workspaceId,
    onReady: async () => { await listMcpTools(deploymentId); },
  };
}

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
    include: {
      server: { select: { name: true, slug: true, installCfg: true } },
      marketInstall: { select: { id: true } },
      toolkitLinks: {
        where: { toolkit: { marketInstall: { isNot: null } } },
        select: { toolkitId: true },
        take: 1,
      },
    },
  });
}

function missingDeploymentEnvironment(deployment: {
  installCfg: unknown;
  server?: { installCfg?: unknown } | null;
}): string[] {
  return missingDeploymentRequiredEnvironment(
    deployment.installCfg,
    deployment.server?.installCfg,
  );
}

async function markDeploymentSetupRequired(deploymentId: string): Promise<void> {
  // Always enter the supervisor lifecycle queue. A live-status check followed
  // by a DB write can race a concurrent launch and leave a process running
  // with credentials the user just removed.
  await killProcess(deploymentId, { finalStatus: 'setup_required' });
}

async function deploymentEnvironmentIsReady(deployment: {
  id: string;
  installCfg: unknown;
  server?: { installCfg?: unknown } | null;
}): Promise<boolean> {
  if (missingDeploymentEnvironment(deployment).length === 0) return true;
  await markDeploymentSetupRequired(deployment.id);
  return false;
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
  const requiresSetup = missingRequiredEnvironment(recipe, data.installCfg).length > 0;
  // `update: {}` on re-deploy intentionally preserves the deployment's existing
  // installCfg — so a user's filled-in env values are not wiped by the recipe's
  // empty seeds. Only the first create seeds from the recipe.
  const dep = await db.deployment.upsert({
    where: { workspaceId_serverId: { workspaceId: ctx.ws.id, serverId } },
    update: {},
    create: {
      workspaceId: ctx.ws.id,
      serverId,
      status: requiresSetup ? 'setup_required' : 'provisioning',
      source: data.source,
      sourceRef: data.sourceRef,
      installCfg: data.installCfg as Prisma.InputJsonValue,
    },
  });

  const operation = await runMcpDeploymentOperation(ctx.ws.id, dep.id, async () => {
    // Re-read inside the deployment lock. An existing deployment can be
    // edited concurrently between the upsert above and process launch.
    const current = await deploymentInWorkspace(dep.id, ctx.ws.id);
    if (!current) return 'missing' as const;
    const currentRecipe = parseServerRecipe(current.server?.installCfg) ?? recipe;
    if (missingRequiredEnvironment(currentRecipe, current.installCfg).length > 0) {
      await markDeploymentSetupRequired(current.id);
      return 'setup_required' as const;
    }
    await startProcess(current.id, resolveSpawnSpec(current), mcpProcessOptions(ctx.ws.id, current.id));
    return 'started' as const;
  });

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/market/mcp`);
  revalidatePath(`/app/${slug}/market/mcp/${server.slug}`);
  if (operation.accepted && operation.value === 'setup_required') {
    return redirect(`/app/${slug}/mcp/${dep.id}?tab=variables`);
  }
  // A catalog install is only useful once people can see its lifecycle,
  // endpoint, and any next setup step. Keep the market focused on discovery
  // and land the user on the deployment they just created.
  redirect(`/app/${slug}/mcp/${dep.id}`);
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
    mcpProcessOptions(ctx.ws.id, dep.id),
  );

  revalidatePath(`/app/${slug}/mcp`);
  redirect(`/app/${slug}/mcp/${dep.id}`);
}

export type McpJsonConfigActionState = {
  error?: 'invalidJsonConfig' | 'notAuthorized' | 'deploymentNotFound' | 'rebuildFailed';
  savedAt?: number;
  requiresSetup?: boolean;
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
  return { config: serializeMcpDeploymentConfig(deployment, { includeEnv: false }) };
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
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const deployment = await db.deployment.findFirst({
      where: {
        id: deploymentId,
        workspaceId: ctx.ws.id,
        source: { in: [...EDITABLE_MCP_SOURCES] },
      },
    });
    if (!deployment || !isEditableMcpSource(deployment.source)) {
      return { error: 'deploymentNotFound' } as const;
    }

    let parsed;
    try {
      parsed = parseMcpDeploymentConfig(
        config,
        deployment.source,
        deployment.name ?? undefined,
        network === null ? undefined : String(network),
        { allowEnvironment: false },
      );
    } catch {
      return { error: 'invalidJsonConfig' } as const;
    }
    if (deployment.serverId && parsed.ref !== deployment.sourceRef) {
      return { error: 'invalidJsonConfig' } as const;
    }
    const catalogServer = deployment.serverId
      ? await db.server.findUnique({
          where: { id: deployment.serverId },
          select: { installCfg: true },
        })
      : null;
    const recipe = parseServerRecipe(catalogServer?.installCfg);
    const requiredEnvironment = recipe?.env
      ?? storedRequiredEnvironment(deployment.installCfg);
    const toolCatalog = readMcpToolCatalog(deployment.installCfg);
    const nextInstallCfg = {
      ...parsed.installCfg,
      // Credentials have a dedicated Variables view. Keep their current
      // values while a user updates launch/configuration fields so two tabs
      // cannot silently overwrite one another.
      env: deploymentEnvironmentValues(deployment.installCfg),
      ...(requiredEnvironment.length ? { requiredEnv: requiredEnvironment } : {}),
      ...(hasMcpToolCatalog(deployment.installCfg) ? { toolCatalog } : {}),
    };
    const requiresSetup = missingRequiredEnvironment(
      { env: requiredEnvironment },
      nextInstallCfg,
    ).length > 0;
    if (requiresSetup) {
      await markDeploymentSetupRequired(deployment.id);
    }
    const updated = await db.$transaction(async (tx) => {
      const value = await tx.deployment.update({
        where: { id: deployment.id },
        data: {
          source: parsed.source,
          sourceRef: parsed.ref,
          installCfg: nextInstallCfg as Prisma.InputJsonValue,
          status: requiresSetup ? 'setup_required' : 'provisioning',
        },
        include: { server: { select: { name: true } } },
      });
      await tx.marketInstall.updateMany({
        where: {
          OR: [
            { deploymentId: deployment.id },
            { toolkit: { is: { servers: { some: { deploymentId: deployment.id } } } } },
          ],
        },
        data: { status: 'modified' },
      });
      return value;
    });

    if (requiresSetup) return { savedAt: Date.now(), requiresSetup: true };

    try {
      await restartProcess(
        updated.id,
        resolveSpawnSpec(updated, true),
        mcpProcessOptions(ctx.ws.id, updated.id),
      );
    } catch {
      await db.deployment.update({
        where: { id: deployment.id },
        data: { status: 'error' },
      });
      return { error: 'rebuildFailed' } as const;
    }
    return { savedAt: Date.now(), requiresSetup: false };
  });

  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
  return operation.accepted ? operation.value : { error: 'deploymentNotFound' };
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
  const publicInvocable = formData.get('publicInvocable') === 'on';
  if (publicInvocable && (mode !== 'allowlist' || selected.length === 0)) {
    return { error: 'invalidToolSelection' };
  }

  await db.$transaction(async (tx) => {
    await tx.deployment.update({
      where: { id: deployment.id },
      data: {
        mcpToolExposure: mode,
        mcpAllowedTools: mode === 'allowlist' ? selected : [],
        publicInvocable,
      },
    });
    await tx.marketInstall.updateMany({
      where: {
        OR: [
          { deploymentId: deployment.id },
          { toolkit: { is: { servers: { some: { deploymentId: deployment.id } } } } },
        ],
      },
      data: { status: 'modified' },
    });
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
  let result: Record<string, unknown> | null = null;
  try {
    result = await mcpRpc(
      deployment.id,
      'tools/call',
      { name: toolName, arguments: input.arguments },
      30_000,
      { maxRequestBytes: 16_000, maxResponseBytes: 1_000_000 },
    );
  } catch {
    result = null;
  }
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

const MAX_DEPLOYMENT_NAME_LENGTH = 80;

type DeploymentEnvironmentPatch = {
  set: Record<string, string>;
  remove: string[];
};

function deploymentEnvironmentValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = (value as Record<string, unknown>).env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (ENV_KEY.test(key) && typeof entry === 'string') env[key] = entry;
  }
  return env;
}

function validDeploymentEnvironment(
  env: Record<string, string>,
): boolean {
  const entries = Object.entries(env);
  if (entries.length > MAX_DEPLOYMENT_ENV_VARS) return false;
  let size = 0;
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key) || value.includes('\0') || value.length > MAX_DEPLOYMENT_ENV_VALUE_LENGTH) {
      return false;
    }
    size += key.length + value.length;
  }
  return size <= MAX_DEPLOYMENT_ENV_LENGTH;
}

function parseDeploymentEnvironmentPatch(value: FormDataEntryValue | null): DeploymentEnvironmentPatch | null {
  try {
    const parsed = JSON.parse(String(value ?? '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rawSet = record.set ?? {};
    const rawRemove = record.remove ?? [];
    if (!rawSet || typeof rawSet !== 'object' || Array.isArray(rawSet) || !Array.isArray(rawRemove)) {
      return null;
    }
    const set: Record<string, string> = {};
    for (const [key, entry] of Object.entries(rawSet as Record<string, unknown>)) {
      if (typeof entry !== 'string') return null;
      set[key] = entry;
    }
    const remove = [...new Set(rawRemove)];
    if (remove.some((key) => typeof key !== 'string' || !ENV_KEY.test(key))) return null;
    if (Object.keys(set).some((key) => !ENV_KEY.test(key))
      || Object.keys(set).length + remove.length > MAX_DEPLOYMENT_ENV_VARS
      || !validDeploymentEnvironment(set)) {
      return null;
    }
    return { set, remove: remove as string[] };
  } catch {
    return null;
  }
}

function deploymentName(value: FormDataEntryValue | null): string {
  return String(value ?? '').trim().slice(0, MAX_DEPLOYMENT_NAME_LENGTH);
}

function cloneInstallCfg(
  value: Prisma.JsonValue,
  copyEnvironmentVariables: boolean,
  requiredEnvironment: string[],
): Prisma.InputJsonValue | undefined {
  if (copyEnvironmentVariables && requiredEnvironment.length === 0) {
    if (value === null) return undefined;
    return value as Prisma.InputJsonValue;
  }

  const configuration = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
  if (requiredEnvironment.length > 0) {
    configuration.requiredEnv = [...requiredEnvironment];
  }
  if (!copyEnvironmentVariables) {
    if (requiredEnvironment.length > 0) {
      configuration.env = Object.fromEntries(requiredEnvironment.map((key) => [key, '']));
    } else {
      delete configuration.env;
    }
  }
  return configuration as Prisma.InputJsonValue;
}

export async function setDeploymentEnvAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const patch = formData.has('changes')
    ? parseDeploymentEnvironmentPatch(formData.get('changes'))
    : null;
  let legacyEnv: Record<string, string> | null = null;
  if (!formData.has('changes')) {
    try {
      const rows = JSON.parse(String(formData.get('env') ?? '[]')) as { key: string; value: string }[];
      const next: Record<string, string> = {};
      for (const row of rows) {
        if (!row.key || !ENV_KEY.test(row.key)) continue;
        next[row.key] = String(row.value ?? '');
      }
      if (!validDeploymentEnvironment(next)) return;
      legacyEnv = next;
    } catch {
      return;
    }
  }
  if (formData.has('changes') && !patch) return;

  await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await db.deployment.findFirst({
      where: {
        id: deploymentId,
        workspaceId: ctx.ws.id,
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
      select: {
        id: true,
        installCfg: true,
        status: true,
        server: { select: { installCfg: true } },
      },
    });
    if (!dep) return;

    const env = legacyEnv
      ? legacyEnv
      : {
          ...deploymentEnvironmentValues(dep.installCfg),
          ...patch?.set,
        };
    for (const key of patch?.remove ?? []) delete env[key];
    if (!validDeploymentEnvironment(env)) return;

    const next: Record<string, unknown> = {
      ...((dep.installCfg ?? {}) as Record<string, unknown>),
      env,
    };
    const missing = missingDeploymentEnvironment({ ...dep, installCfg: next });
    if (missing.length > 0) {
      // Stop first. If termination fails, retain the old persisted credentials
      // instead of claiming they were removed while their process still runs.
      await markDeploymentSetupRequired(dep.id);
    }
    const nextStatus = missing.length > 0
      ? 'setup_required'
      : dep.status === 'setup_required'
        ? 'stopped'
        : null;
    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        installCfg: next as Prisma.InputJsonValue,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    });
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
  const nameEntry = formData.get('name');
  const copyEnvironmentEntries = formData.getAll('copyEnvironmentVariables').map(String);
  const copyEnvironmentVariables = copyEnvironmentEntries.length === 0
    || copyEnvironmentEntries.includes('true');
  const copyRuntimeFileEntries = formData.getAll('copyRuntimeFiles').map(String);
  const copyRuntimeFiles = copyRuntimeFileEntries.length === 0
    || copyRuntimeFileEntries.includes('true');
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const source = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!source) return null;

    const defaultName = `${deploymentLabel(source).name
      .slice(0, MAX_DEPLOYMENT_NAME_LENGTH - 5)
      .trimEnd()} Copy`;
    const name = nameEntry === null ? defaultName : deploymentName(nameEntry);
    if (!name) return null;

    // A detached clone retains required key names in installCfg so future
    // lifecycle operations can enforce them without a Server relation.
    const sourceRecipe = parseServerRecipe(source.server?.installCfg);
    const requiredEnvironment = sourceRecipe?.env
      ?? storedRequiredEnvironment(source.installCfg);
    const clonedInstallCfg = cloneInstallCfg(
      source.installCfg,
      copyEnvironmentVariables,
      requiredEnvironment,
    );
    const cloneRequiresSetup = missingRequiredEnvironment(
      { env: requiredEnvironment },
      clonedInstallCfg,
    ).length > 0;
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
        installCfg: clonedInstallCfg,
        status: cloneRequiresSetup ? 'setup_required' : 'provisioning',
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

    if (cloneRequiresSetup) return { id: cloned.id, setupRequired: true };

    // Once the row exists it is discoverable by other requests. Acquire the
    // target deployment lock and re-read before launch so a concurrent env
    // edit cannot be overwritten by this clone's stale spawn spec.
    const targetOperation = await runMcpDeploymentOperation(ctx.ws.id, cloned.id, async () => {
      const current = await deploymentInWorkspace(cloned.id, ctx.ws.id);
      if (!current) return null;
      if (!(await deploymentEnvironmentIsReady(current))) {
        return { id: cloned.id, setupRequired: true };
      }
      await startProcess(current.id, resolveSpawnSpec(current), mcpProcessOptions(ctx.ws.id, current.id));
      return { id: cloned.id, setupRequired: false };
    });
    return targetOperation.accepted ? targetOperation.value : null;
  });
  if (!operation.accepted || !operation.value) return;
  revalidatePath(`/app/${slug}/mcp`);
  redirect(
    `/app/${slug}/mcp/${operation.value.id}${operation.value.setupRequired ? '?tab=variables' : ''}`,
  );
}

export async function removeDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!dep) return null;
    if (dep.marketInstall || dep.toolkitLinks?.length) return null;

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
    return { serverSlug: dep.server?.slug ?? null };
  });
  if (!operation.accepted || !operation.value) return;
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/market/mcp`);
  if (operation.value.serverSlug) {
    revalidatePath(`/app/${slug}/market/mcp/${operation.value.serverSlug}`);
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
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!dep) return 'missing' as const;
    if (!(await deploymentEnvironmentIsReady(dep))) return 'setup_required' as const;
    await startProcess(dep.id, resolveSpawnSpec(dep), mcpProcessOptions(ctx.ws.id, dep.id));
    return 'started' as const;
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
  if (!operation.accepted || operation.value === 'missing') return;
  if (operation.value === 'setup_required') {
    return redirect(`/app/${slug}/mcp/${deploymentId}?tab=variables`);
  }
  return redirect(`/app/${slug}/mcp/${deploymentId}?tab=logs#runtime-logs`);
}

export async function stopDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!dep) return;
    if (missingDeploymentEnvironment(dep).length > 0) {
      await markDeploymentSetupRequired(dep.id);
    } else {
      await stopProcess(deploymentId);
    }
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
}

export async function restartDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!dep) return 'missing' as const;
    if (!(await deploymentEnvironmentIsReady(dep))) return 'setup_required' as const;
    await restartProcess(dep.id, resolveSpawnSpec(dep), mcpProcessOptions(ctx.ws.id, dep.id));
    return 'restarted' as const;
  });
  revalidatePath(`/app/${slug}/mcp`);
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
  if (!operation.accepted || operation.value === 'missing') return;
  if (operation.value === 'setup_required') {
    return redirect(`/app/${slug}/mcp/${deploymentId}?tab=variables`);
  }
  return redirect(`/app/${slug}/mcp/${deploymentId}?tab=logs#runtime-logs`);
}

// Rebuild = tear the process down and spawn it fresh, re-fetching the package /
// image (vs. Restart, which reuses the cached one).
export async function rebuildDeploymentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const operation = await runMcpDeploymentOperation(ctx.ws.id, deploymentId, async () => {
    const dep = await deploymentInWorkspace(deploymentId, ctx.ws.id);
    if (!dep) return 'missing' as const;
    if (!(await deploymentEnvironmentIsReady(dep))) return 'setup_required' as const;
    await restartProcess(dep.id, resolveSpawnSpec(dep, true), mcpProcessOptions(ctx.ws.id, dep.id));
    return 'rebuilt' as const;
  });
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
  revalidatePath(`/app/${slug}/mcp`);
  if (!operation.accepted || operation.value === 'missing') return;
  if (operation.value === 'setup_required') {
    return redirect(`/app/${slug}/mcp/${deploymentId}?tab=variables`);
  }
  return redirect(`/app/${slug}/mcp/${deploymentId}?tab=logs#runtime-logs`);
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
    select: {
      skill: { select: { slug: true } },
      marketInstall: { select: { id: true } },
      toolkitLinks: {
        where: { toolkit: { marketInstall: { isNot: null } } },
        select: { toolkitId: true },
        take: 1,
      },
    },
  });
  if (!installed) return;
  if (installed.marketInstall || installed.toolkitLinks?.length) return;

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
