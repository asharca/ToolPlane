import 'server-only';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getAgent } from '@/lib/agents/queries';
import { resolveAgentTools, type SkillForPrompt } from '@/lib/agents/resolve';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { parseSkillFrontmatter } from '@/lib/skills/bundle';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import {
  killProcess,
  livePort,
  restartProcess,
  startProcess,
  stopProcess,
} from '@/lib/process/supervisor';
import {
  removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict,
  sandboxContainerName,
  sandboxSyncContainerName,
  sandboxVolumeName,
} from '@/lib/sandboxes/runtime';
import { HERMES_RUNTIME_KIND } from './constants';
import {
  renderHermesConfig,
  renderHermesMcpBindingFingerprint,
  renderHermesSkillBundle,
} from './config';
import { deriveHermesRuntimeToken } from './token';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';

const DOCKER_TIMEOUT_MS = 15 * 60_000;
const TOOLPLANE_SKILL_ROOT = 'toolplane-agent';
const HERMES_CONFIG_VERSION = 5;
const DASHBOARD_READY_CACHE_MS = 15_000;
const BLOCKED_SANDBOX_LIFECYCLE_STATES = new Set([
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
  'deleting',
]);
const SANDBOX_LIFECYCLE_ERROR = 'The Hermes sandbox has a pending lifecycle operation.';
const CONFIG_MERGE_SCRIPT = String.raw`import os
import pathlib
import sys
import tempfile

import yaml


def load_mapping(path):
    if not path.exists():
        return {}
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"Expected a YAML mapping in {path}")
    return value


def deep_merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = value


destination = pathlib.Path(sys.argv[1])
managed = load_mapping(pathlib.Path(sys.argv[2]))
current = load_mapping(destination)

provider_prefix = "toolplane-"
managed_providers = managed.get("providers", {})
if not isinstance(managed_providers, dict):
    managed_providers = {}
current_providers = current.get("providers", {})
if not isinstance(current_providers, dict):
    current_providers = {}


def provider_name(entry):
    if not isinstance(entry, dict):
        return ""
    value = entry.get("name", "")
    return value.strip().lower() if isinstance(value, str) else ""


current["providers"] = {
    **{
        key: value for key, value in current_providers.items()
        if not str(key).strip().lower().startswith(provider_prefix)
    },
    **managed_providers,
}

# Remove entries written by older ToolPlane projections. Hermes may migrate
# custom_providers into providers on startup, so both shapes are cleaned.
current_custom_providers = current.get("custom_providers", [])
if isinstance(current_custom_providers, list):
    current_custom_providers = [
        entry for entry in current_custom_providers
        if not provider_name(entry).startswith(provider_prefix)
        and not str(entry.get("provider_key", "") if isinstance(entry, dict) else "").strip().lower().startswith(provider_prefix)
    ]
    if current_custom_providers:
        current["custom_providers"] = current_custom_providers
    else:
        current.pop("custom_providers", None)

managed_models = {}
for key, entry in managed_providers.items():
    models = entry.get("models", {}) if isinstance(entry, dict) else {}
    if isinstance(models, dict):
        provider_key = str(key).strip().lower()
        managed_models[provider_key] = set(models.keys())
        managed_models[f"custom:{provider_key}"] = set(models.keys())

current_model = current.get("model")
managed_model = managed.get("model")
replace_model = not isinstance(current_model, dict)
if isinstance(current_model, dict):
    current_provider = str(current_model.get("provider", "")).strip().lower()
    current_default = str(current_model.get("default", "")).strip()
    if not current_provider or not current_default:
        replace_model = True
    elif current_provider.startswith(f"custom:{provider_prefix}") or current_provider.startswith(provider_prefix):
        allowed_models = managed_models.get(current_provider)
        replace_model = allowed_models is None or (bool(allowed_models) and current_default not in allowed_models)

if replace_model:
    if isinstance(managed_model, dict):
        current["model"] = managed_model
    else:
        current.pop("model", None)

for section in ("agent", "approvals", "tool_loop_guardrails"):
    incoming = managed.get(section, {})
    existing = current.get(section)
    if not isinstance(existing, dict):
        existing = {}
    deep_merge(existing, incoming)
    current[section] = existing

managed_mcp = managed.get("mcp_servers", {})
current_mcp = current.get("mcp_servers")
if not isinstance(current_mcp, dict):
    current_mcp = {}
if isinstance(managed_mcp, dict) and "toolplane" in managed_mcp:
    current_mcp["toolplane"] = managed_mcp["toolplane"]
current["mcp_servers"] = current_mcp

destination.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".config.yaml.", dir=destination.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        yaml.safe_dump(current, handle, sort_keys=False, allow_unicode=True)
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
`;

type DockerResult = { stdout: string; stderr: string };

type DashboardReadyEntry = { port: number; checkedAt: number };
const globalRuntime = globalThis as unknown as {
  __hermesDashboardReady?: Map<string, DashboardReadyEntry>;
  __hermesOperationQueues?: Map<string, Promise<void>>;
};

function dashboardReadyCache(): Map<string, DashboardReadyEntry> {
  if (!globalRuntime.__hermesDashboardReady) globalRuntime.__hermesDashboardReady = new Map();
  return globalRuntime.__hermesDashboardReady;
}

function enqueueHermesOperation<T>(
  workspaceId: string,
  agentId: string,
  rejected: T,
  operation: () => Promise<T>,
): Promise<T> {
  const releaseWorkspaceOperation = beginWorkspaceOperation(workspaceId);
  if (!releaseWorkspaceOperation) return Promise.resolve(rejected);
  const queues = globalRuntime.__hermesOperationQueues ??= new Map();
  const key = `${workspaceId}:${agentId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return result.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
    releaseWorkspaceOperation();
  });
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runDocker(args: string[], input?: string): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), DOCKER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `docker exited with code ${code}`));
    });
    child.stdin.end(input ?? '');
  });
}

function safeSkillName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return name || 'skill';
}

function runtimePublicBaseUrl(): string {
  const configured = process.env.TOOLPLANE_HERMES_CALLBACK_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'http://localhost:3000';
  const url = new URL(configured);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.hostname = 'host.docker.internal';
  }
  return url.toString().replace(/\/$/, '');
}

export function hermesRuntimeMcpUrl(runtimeId: string): string {
  return `${runtimePublicBaseUrl()}/api/v1/agent-runtimes/${encodeURIComponent(runtimeId)}/mcp`;
}

async function writeSkill(
  root: string,
  skill: SkillForPrompt,
  usedNames: Set<string>,
  hash: ReturnType<typeof createHash>,
): Promise<string> {
  const markdown = buildInstalledSkillMarkdown(skill);
  const frontmatterName = parseSkillFrontmatter(markdown).name;
  const fallback = skill.slug || skill.skill?.slug || skill.name || skill.skill?.name || 'skill';
  const base = safeSkillName(frontmatterName || fallback);
  let name = base;
  for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${base}-${suffix}`;
  usedNames.add(name);

  const directory = path.join(root, 'skills', TOOLPLANE_SKILL_ROOT, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), markdown, { mode: 0o600 });
  hash.update(`SKILL.md:${name}\0${markdown}\0`);

  for (const file of installedSkillExtraFiles(skill)) {
    const target = path.join(directory, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    const content = file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : file.content;
    await writeFile(target, content, { mode: 0o600 });
    hash.update(`${name}/${file.path}\0`);
    hash.update(typeof content === 'string' ? content : content);
    hash.update('\0');
  }
  return name;
}

async function buildProjection(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
): Promise<{ directory: string; configHash: string }> {
  if (!agent.runtime) throw new Error('Hermes runtime is not configured.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'toolplane-hermes-'));
  const hash = createHash('sha256');
  const resolved = resolveAgentTools(agent);
  const config = renderHermesConfig({
    maxSteps: agent.maxSteps,
    providers: agent.modelProviders.map(({ provider }) => ({
      id: provider.id,
      name: provider.name,
      format: provider.format,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      models: provider.models,
    })),
    mcpUrl: hermesRuntimeMcpUrl(agent.runtime.id),
    mcpToken: deriveHermesRuntimeToken(agent.runtime.id, 'toolplane-mcp'),
  });
  await writeFile(path.join(directory, 'config.yaml'), config, { mode: 0o600 });
  await writeFile(
    path.join(directory, '.toolplane-merge-config.py'),
    CONFIG_MERGE_SCRIPT,
    { mode: 0o600 },
  );
  hash.update(config);
  hash.update(`mcp-bindings\0${renderHermesMcpBindingFingerprint(resolved.deploymentIds)}\0`);

  const usedNames = new Set<string>();
  const skillNames: string[] = [];
  for (const skill of resolved.skills) {
    skillNames.push(await writeSkill(directory, skill, usedNames, hash));
  }
  await mkdir(path.join(directory, 'skill-bundles'), { recursive: true });
  const bundle = renderHermesSkillBundle(skillNames);
  await writeFile(
    path.join(directory, 'skill-bundles', `${TOOLPLANE_SKILL_ROOT}.yaml`),
    bundle,
    { mode: 0o600 },
  );
  hash.update(bundle);
  return { directory, configHash: hash.digest('hex') };
}

async function installProjection(params: {
  directory: string;
  image: string;
  sandboxId: string;
}) {
  const volume = sandboxVolumeName(params.sandboxId);
  const initContainer = sandboxSyncContainerName(params.sandboxId);
  await runDocker(['volume', 'create', volume]);
  await runDocker(['rm', '-f', initContainer]).catch(() => undefined);
  const installCommand = [
    'set -eu',
    `rm -rf /opt/data/skills/${TOOLPLANE_SKILL_ROOT} /opt/data/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml`,
    'mkdir -p /opt/data/skills /opt/data/skill-bundles',
    `if [ -d /tmp/toolplane/skills/${TOOLPLANE_SKILL_ROOT} ]; then cp -R /tmp/toolplane/skills/${TOOLPLANE_SKILL_ROOT} /opt/data/skills/; fi`,
    `if [ -f /tmp/toolplane/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml ]; then cp /tmp/toolplane/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml /opt/data/skill-bundles/; fi`,
    '/opt/hermes/.venv/bin/python /tmp/toolplane/.toolplane-merge-config.py /opt/data/config.yaml /tmp/toolplane/config.yaml',
    'if id hermes >/dev/null 2>&1; then chown -R "$(id -u hermes):$(id -g hermes)" /opt/data/config.yaml /opt/data/skills /opt/data/skill-bundles /opt/data/memories /opt/data/workspace 2>/dev/null || true; fi',
  ].join(' && ');
  await runDocker([
    'create', '--name', initContainer, '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges',
    '-v', `${volume}:/opt/data`, '--entrypoint', '/bin/sh', params.image, '-c', installCommand,
  ]);
  try {
    await runDocker(['cp', `${params.directory}/.`, `${initContainer}:/tmp/toolplane`]);
    await runDocker(['start', '--attach', initContainer]);
  } finally {
    await runDocker(['rm', '-f', initContainer]).catch(() => undefined);
  }
}

async function updateRuntimeState(
  workspaceId: string,
  runtimeId: string,
  data: Prisma.AgentRuntimeUpdateManyMutationInput,
) {
  await db.agentRuntime.updateMany({ where: { id: runtimeId, workspaceId }, data });
}

export async function syncHermesRuntime(
  workspaceId: string,
  agentId: string,
  options: { start?: boolean } = {},
): Promise<{ status: string; error?: string }> {
  return enqueueHermesOperation(
    workspaceId,
    agentId,
    { status: 'deleting', error: SANDBOX_LIFECYCLE_ERROR },
    () => syncHermesRuntimeUnlocked(workspaceId, agentId, options),
  );
}

async function syncHermesRuntimeUnlocked(
  workspaceId: string,
  agentId: string,
  options: { start?: boolean } = {},
): Promise<{ status: string; error?: string }> {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { status: 'native' };
  }
  const runtime = agent.runtime;
  const deploymentId = runtime.sandbox.deploymentId;
  const deploymentStatus = runtime.sandbox.deployment.status;
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(deploymentStatus)) {
    return { status: deploymentStatus, error: SANDBOX_LIFECYCLE_ERROR };
  }
  let projection: Awaited<ReturnType<typeof buildProjection>> | null = null;

  try {
    projection = await buildProjection(agent);
    const configured = agent.modelProviders.length > 0;
    if (
      projection.configHash === runtime.configHash
      && runtime.configVersion >= HERMES_CONFIG_VERSION
    ) {
      if (!configured || options.start === false) {
        const status = configured ? 'stopped' : 'setup_required';
        await updateRuntimeState(workspaceId, runtime.id, { status, lastError: null });
        return { status };
      }
      if (!livePort(deploymentId)) {
        await startProcess(deploymentId, resolveSpawnSpec(runtime.sandbox.deployment), {
          awaitReady: false,
          workspaceId,
        });
        await updateRuntimeState(workspaceId, runtime.id, {
          status: 'provisioning',
          lastStartedAt: new Date(),
          lastError: null,
        });
        return { status: 'provisioning' };
      }
      return { status: runtime.status };
    }

    await killProcess(deploymentId);
    await removeDockerSandboxContainer(runtime.sandboxId);
    await installProjection({
      directory: projection.directory,
      image: runtime.image,
      sandboxId: runtime.sandboxId,
    });

    const nextStatus = configured && options.start !== false ? 'provisioning' : 'setup_required';
    await Promise.all([
      updateRuntimeState(workspaceId, runtime.id, {
        status: nextStatus,
        configVersion: HERMES_CONFIG_VERSION,
        configHash: projection.configHash,
        lastSyncedAt: new Date(),
        lastStartedAt: configured && options.start !== false ? new Date() : runtime.lastStartedAt,
        lastError: null,
      }),
      db.deployment.updateMany({
        where: { id: deploymentId, workspaceId },
        data: { status: configured && options.start !== false ? 'provisioning' : 'stopped' },
      }),
    ]);

    if (!configured || options.start === false) return { status: nextStatus };
    await startProcess(deploymentId, resolveSpawnSpec(runtime.sandbox.deployment), {
      awaitReady: false,
      workspaceId,
    });
    return { status: 'provisioning' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([
      updateRuntimeState(workspaceId, runtime.id, { status: 'error', lastError: message.slice(0, 4000) }),
      db.deployment.updateMany({
        where: { id: deploymentId, workspaceId },
        data: { status: 'error' },
      }),
    ]);
    return { status: 'error', error: message };
  } finally {
    if (projection) await rm(projection.directory, { recursive: true, force: true });
  }
}

async function waitForHermesHealth(deploymentId: string): Promise<number | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const port = livePort(deploymentId);
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/hermes/health`, {
          signal: AbortSignal.timeout(5_000),
          cache: 'no-store',
        });
        if (response.ok) return port;
      } catch {
        // Gateway may still be booting or pulling the image.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

async function waitForHermesDashboard(deploymentId: string): Promise<number | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const port = livePort(deploymentId);
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/hermes-dashboard/api/status`, {
          signal: AbortSignal.timeout(5_000),
          cache: 'no-store',
        });
        if (response.ok) return port;
      } catch {
        // The dashboard starts alongside the gateway and may need a few seconds.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return null;
}

export async function ensureHermesRuntimeReady(
  workspaceId: string,
  agentId: string,
): Promise<{ port?: number; error?: string }> {
  return enqueueHermesOperation(
    workspaceId,
    agentId,
    { error: SANDBOX_LIFECYCLE_ERROR },
    () => ensureHermesRuntimeReadyUnlocked(workspaceId, agentId),
  );
}

async function ensureHermesRuntimeReadyUnlocked(
  workspaceId: string,
  agentId: string,
): Promise<{ port?: number; error?: string }> {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { error: 'Hermes runtime is not configured.' };
  }
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(agent.runtime.sandbox.deployment.status)) {
    return { error: SANDBOX_LIFECYCLE_ERROR };
  }
  if (agent.modelProviders.length === 0) {
    return { error: 'This Hermes agent has no model provider configured.' };
  }

  const deploymentId = agent.runtime.sandbox.deploymentId;
  if (!livePort(deploymentId)) {
    await startProcess(
      deploymentId,
      resolveSpawnSpec(agent.runtime.sandbox.deployment),
      { awaitReady: true, workspaceId },
    );
  }
  const port = await waitForHermesHealth(deploymentId);
  if (!port) {
    const message = 'Hermes gateway did not become healthy within 45 seconds.';
    await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'error', lastError: message });
    return { error: message };
  }
  await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'running', lastError: null });
  return { port };
}

export async function ensureHermesDashboardReady(
  workspaceId: string,
  agentId: string,
): Promise<{ port?: number; error?: string }> {
  return enqueueHermesOperation(
    workspaceId,
    agentId,
    { error: SANDBOX_LIFECYCLE_ERROR },
    () => ensureHermesDashboardReadyUnlocked(workspaceId, agentId),
  );
}

async function ensureHermesDashboardReadyUnlocked(
  workspaceId: string,
  agentId: string,
): Promise<{ port?: number; error?: string }> {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { error: 'Hermes runtime is not configured.' };
  }
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(agent.runtime.sandbox.deployment.status)) {
    return { error: SANDBOX_LIFECYCLE_ERROR };
  }

  const deploymentId = agent.runtime.sandbox.deploymentId;
  const live = livePort(deploymentId);
  const cached = dashboardReadyCache().get(deploymentId);
  if (
    live
    && cached?.port === live
    && Date.now() - cached.checkedAt < DASHBOARD_READY_CACHE_MS
  ) {
    return { port: live };
  }
  const spec = resolveSpawnSpec(agent.runtime.sandbox.deployment);
  if (!live) {
    await startProcess(deploymentId, spec, { awaitReady: true, workspaceId });
  }

  let port = await waitForHermesDashboard(deploymentId);
  if (!port) {
    dashboardReadyCache().delete(deploymentId);
    await restartProcess(deploymentId, spec, { awaitReady: true, workspaceId });
    port = await waitForHermesDashboard(deploymentId);
  }
  if (!port) {
    const message = 'Hermes dashboard did not become healthy within 45 seconds.';
    await updateRuntimeState(workspaceId, agent.runtime.id, { lastError: message });
    return { error: message };
  }
  await updateRuntimeState(workspaceId, agent.runtime.id, {
    ...(agent.modelProviders.length > 0 ? { status: 'running' } : {}),
    lastError: null,
  });
  dashboardReadyCache().set(deploymentId, { port, checkedAt: Date.now() });
  return { port };
}

export async function stopHermesRuntime(workspaceId: string, agentId: string) {
  await enqueueHermesOperation(
    workspaceId,
    agentId,
    undefined,
    () => stopHermesRuntimeUnlocked(workspaceId, agentId),
  );
}

async function stopHermesRuntimeUnlocked(workspaceId: string, agentId: string) {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) return;
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(agent.runtime.sandbox.deployment.status)) return;
  dashboardReadyCache().delete(agent.runtime.sandbox.deploymentId);
  await stopProcess(agent.runtime.sandbox.deploymentId);
  await runDocker(['stop', '--time', '10', sandboxContainerName(agent.runtime.sandboxId)]).catch(() => undefined);
  await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'stopped', lastError: null });
}

export async function cleanupHermesRuntime(
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  return enqueueHermesOperation(workspaceId, agentId, false, async () => {
    const agent = await getAgent(workspaceId, agentId);
    if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) return true;
    dashboardReadyCache().delete(agent.runtime.sandbox.deploymentId);
    await killProcess(agent.runtime.sandbox.deploymentId, {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    await db.deployment.updateMany({
      where: {
        id: agent.runtime.sandbox.deploymentId,
        workspaceId,
        source: 'sandbox',
      },
      data: { status: 'deleting' },
    });
    await removeDockerSandboxRuntimeStrict(
      agent.runtime.sandboxId,
      sandboxVolumeName(agent.runtime.sandboxId),
    );
    return true;
  });
}
