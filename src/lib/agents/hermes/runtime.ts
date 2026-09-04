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
  effectiveStatus,
  killProcess,
  livePort,
  restartProcess,
  startProcess,
  stopProcess,
} from '@/lib/process/supervisor';
import {
  copyDockerVolume,
  removeDockerSandboxRuntimeStrict,
  pullDockerImage,
  sandboxContainerName,
  sandboxSyncContainerName,
  sandboxVolumeName,
  stopDockerSandboxContainer,
} from '@/lib/sandboxes/runtime';
import { HERMES_RUNTIME_KIND, isValidHermesImage } from './constants';
import { HERMES_ARCHIVE_IMPORT_TIMEOUT_MS } from './archive-limits';
import {
  renderHermesConfig,
  renderHermesEnvPayload,
  renderHermesMcpBindingFingerprint,
  renderHermesSkillBundle,
} from './config';
import { deriveHermesRuntimeToken } from './token';
import {
  HERMES_ENV_MERGE_SCRIPT,
  withoutHermesChannelEnv,
} from './env-merge-script';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { readSandboxEnv, sandboxConfigWithEnv } from '@/lib/sandboxes/env';
import { runtimeEnv } from '@/lib/runtime-env';

const DOCKER_TIMEOUT_MS = 15 * 60_000;
const HERMES_ARCHIVE_COPY_TIMEOUT_MS = HERMES_ARCHIVE_IMPORT_TIMEOUT_MS;
const HERMES_SYNC_CONTAINER_RESOURCE_LIMITS = [
  '--memory', '1g',
  '--memory-swap', '1g',
  '--pids-limit', '256',
  '--cpus', '2',
];
const TOOLPLANE_SKILL_ROOT = 'toolplane-agent';
const HERMES_CONFIG_VERSION = 8;
const DASHBOARD_READY_CACHE_MS = 15_000;
const BLOCKED_SANDBOX_LIFECYCLE_STATES = new Set([
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
  'upgrading',
  'deleting',
]);
const SANDBOX_LIFECYCLE_ERROR = 'The Hermes sandbox has a pending lifecycle operation.';
const CONFIG_COMPATIBILITY_SCRIPT = String.raw`import pathlib
import sys

import yaml
try:
    from hermes_cli.config_migrations import SUPPORT_FLOOR_VERSION
except (ImportError, AttributeError):
    # Images from before Hermes introduced a migration support floor retain
    # their original migration behavior and remain valid ToolPlane targets.
    raise SystemExit(0)


paths = [pathlib.Path(value) for value in sys.argv[1:]]
if not paths:
    paths = [pathlib.Path("/opt/data/config.yaml")]
    paths.extend(pathlib.Path("/opt/data/profiles").glob("*/config.yaml"))
for path in paths:
    if not path.exists():
        continue
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or "_config_version" not in value:
        continue
    raw_version = value.get("_config_version")
    try:
        version = 0 if isinstance(raw_version, bool) else max(int(raw_version), 0)
    except (TypeError, ValueError):
        version = 0
    if version < SUPPORT_FLOOR_VERSION:
        print(
            f"ToolPlane cannot safely sync {path} because it has _config_version "
            f"{version}, below Hermes' supported migration floor "
            f"{SUPPORT_FLOOR_VERSION}. Back it up, review the Hermes changelog, "
            "and migrate it manually before syncing; the running container and "
            "volume were left unchanged.",
            file=sys.stderr,
        )
        raise SystemExit(78)
`;
const CONFIG_MERGE_SCRIPT = String.raw`import os
import pathlib
import sys
import tempfile

import yaml


def load_mapping(path):
    if str(path) == "-":
        value = yaml.safe_load(sys.stdin.read())
    else:
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

for section in ("agent", "approvals", "tool_loop_guardrails", "platforms"):
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
type HermesGatewayHealth = {
  gatewayState?: string;
  pid?: number;
  exitReason?: string;
};
type HermesRuntimeAccessState = {
  activeWrites: number;
  copyInProgress: boolean;
  pendingCopies: number;
  drained?: Promise<void>;
  resolveDrained?: () => void;
  available?: Promise<void>;
  resolveAvailable?: () => void;
};

export type HermesRuntimeWriteLease = {
  release: () => void;
};

type HermesRuntimeWriteLeaseInfo = {
  key: string;
  released: boolean;
};

const runtimeWriteLeaseInfo = new WeakMap<HermesRuntimeWriteLease, HermesRuntimeWriteLeaseInfo>();

export const HERMES_RUNTIME_MAINTENANCE_IN_PROGRESS_ERROR =
  'The Hermes runtime is temporarily unavailable while a clone or image upgrade is in progress.';

// Retain the original export for existing API callers while broadening its
// message now that the same write gate also protects image upgrades.
export const HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR = HERMES_RUNTIME_MAINTENANCE_IN_PROGRESS_ERROR;

const globalRuntime = globalThis as unknown as {
  __hermesDashboardReady?: Map<string, DashboardReadyEntry>;
  __hermesOperationQueues?: Map<string, Promise<void>>;
  __hermesRuntimeAccessStates?: Map<string, HermesRuntimeAccessState>;
};

function dashboardReadyCache(): Map<string, DashboardReadyEntry> {
  if (!globalRuntime.__hermesDashboardReady) globalRuntime.__hermesDashboardReady = new Map();
  return globalRuntime.__hermesDashboardReady;
}

function hermesRuntimeAccessKey(workspaceId: string, agentId: string) {
  return `${workspaceId}:${agentId}`;
}

function hermesRuntimeAccessStates(): Map<string, HermesRuntimeAccessState> {
  return globalRuntime.__hermesRuntimeAccessStates ??= new Map();
}

function getHermesRuntimeAccessState(
  workspaceId: string,
  agentId: string,
): HermesRuntimeAccessState {
  const states = hermesRuntimeAccessStates();
  const key = hermesRuntimeAccessKey(workspaceId, agentId);
  let state = states.get(key);
  if (!state) {
    state = {
      activeWrites: 0,
      copyInProgress: false,
      pendingCopies: 0,
    };
    states.set(key, state);
  }
  return state;
}

function clearHermesRuntimeAccessStateIfIdle(
  workspaceId: string,
  agentId: string,
  state: HermesRuntimeAccessState,
) {
  if (
    state.activeWrites !== 0
    || state.copyInProgress
    || state.pendingCopies !== 0
    || state.drained
    || state.available
  ) return;
  const states = hermesRuntimeAccessStates();
  const key = hermesRuntimeAccessKey(workspaceId, agentId);
  if (states.get(key) === state) states.delete(key);
}

function runtimeAccessIsClosed(workspaceId: string, agentId: string): boolean {
  const state = hermesRuntimeAccessStates().get(hermesRuntimeAccessKey(workspaceId, agentId));
  return Boolean(state && (state.copyInProgress || state.pendingCopies > 0));
}

function holdsHermesRuntimeWriteLease(
  workspaceId: string,
  agentId: string,
  lease: HermesRuntimeWriteLease | undefined,
): boolean {
  if (!lease) return false;
  const info = runtimeWriteLeaseInfo.get(lease);
  return Boolean(
    info
    && !info.released
    && info.key === hermesRuntimeAccessKey(workspaceId, agentId),
  );
}

/**
 * Admit a request that can mutate a Hermes volume or its paired conversation
 * records. A volume clone closes this shared gate before it queues lifecycle
 * work, so already-admitted requests can drain without deadlocking on
 * `ensureHermesRuntimeReady`, while new requests fail fast.
 */
export function acquireHermesRuntimeWriteLease(
  workspaceId: string,
  agentId: string,
): HermesRuntimeWriteLease | null {
  const state = getHermesRuntimeAccessState(workspaceId, agentId);
  if (state.copyInProgress || state.pendingCopies > 0) return null;

  state.activeWrites += 1;
  const info: HermesRuntimeWriteLeaseInfo = {
    key: hermesRuntimeAccessKey(workspaceId, agentId),
    released: false,
  };
  const lease: HermesRuntimeWriteLease = {
    release: () => {
      if (info.released) return;
      info.released = true;
      state.activeWrites -= 1;
      if (state.activeWrites === 0) {
        state.resolveDrained?.();
        state.drained = undefined;
        state.resolveDrained = undefined;
      }
      clearHermesRuntimeAccessStateIfIdle(workspaceId, agentId, state);
    },
  };
  runtimeWriteLeaseInfo.set(lease, info);
  return lease;
}

function reserveHermesRuntimeCopyLease(
  workspaceId: string,
  agentId: string,
): HermesRuntimeAccessState {
  const state = getHermesRuntimeAccessState(workspaceId, agentId);
  state.pendingCopies += 1;
  return state;
}

function cancelHermesRuntimeCopyReservation(
  workspaceId: string,
  agentId: string,
  state: HermesRuntimeAccessState,
) {
  state.pendingCopies -= 1;
  clearHermesRuntimeAccessStateIfIdle(workspaceId, agentId, state);
}

async function activateHermesRuntimeCopyLease(
  workspaceId: string,
  agentId: string,
  state: HermesRuntimeAccessState,
): Promise<() => void> {
  while (state.copyInProgress) {
    if (!state.available) {
      state.available = new Promise<void>((resolve) => {
        state.resolveAvailable = resolve;
      });
    }
    await state.available;
  }
  state.pendingCopies -= 1;
  state.copyInProgress = true;

  if (state.activeWrites > 0) {
    if (!state.drained) {
      state.drained = new Promise<void>((resolve) => {
        state.resolveDrained = resolve;
      });
    }
    await state.drained;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.copyInProgress = false;
    state.resolveAvailable?.();
    state.available = undefined;
    state.resolveAvailable = undefined;
    clearHermesRuntimeAccessStateIfIdle(workspaceId, agentId, state);
  };
}

async function acquireHermesRuntimePairCopyLeases(
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
): Promise<() => void> {
  const agentIds = [sourceAgentId, targetAgentId].sort();
  // Reserve both gates synchronously before awaiting either drain. This is
  // what makes the barrier atomic from callers' perspective: no new write can
  // sneak into the second runtime while the first one is still draining.
  const reservations = agentIds.map((agentId) => ({
    agentId,
    state: reserveHermesRuntimeCopyLease(workspaceId, agentId),
  }));
  const releases: Array<() => void> = [];
  try {
    for (const reservation of reservations) {
      releases.push(await activateHermesRuntimeCopyLease(
        workspaceId,
        reservation.agentId,
        reservation.state,
      ));
    }
  } catch (error) {
    for (const release of releases.reverse()) release();
    for (const reservation of reservations.slice(releases.length)) {
      cancelHermesRuntimeCopyReservation(workspaceId, reservation.agentId, reservation.state);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release();
  };
}

// An image upgrade has the same safety requirements as a volume clone for a
// single runtime: wait for already-admitted writes to drain, then reject new
// writes until the container has been rebuilt. Keep the underlying access
// state shared with clone operations so they cannot overlap.
async function acquireHermesRuntimeUpgradeLease(
  workspaceId: string,
  agentId: string,
): Promise<() => void> {
  const state = reserveHermesRuntimeCopyLease(workspaceId, agentId);
  try {
    return await activateHermesRuntimeCopyLease(workspaceId, agentId, state);
  } catch (error) {
    cancelHermesRuntimeCopyReservation(workspaceId, agentId, state);
    throw error;
  }
}

type HermesOperationAccess = {
  bypassRuntimeAccessGate?: boolean;
  writeLease?: HermesRuntimeWriteLease;
};

function enqueueHermesOperation<T>(
  workspaceId: string,
  agentId: string,
  rejected: T,
  operation: () => Promise<T>,
  access: HermesOperationAccess = {},
): Promise<T> {
  if (
    !access.bypassRuntimeAccessGate
    && runtimeAccessIsClosed(workspaceId, agentId)
    && !holdsHermesRuntimeWriteLease(workspaceId, agentId, access.writeLease)
  ) return Promise.resolve(rejected);
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

/**
 * Serialize a Hermes Dashboard mutation with sync, stop, clone, restore, and
 * upgrade operations for the same agent. The caller must acquire a write
 * lease before reading the HTTP request body so maintenance can drain an
 * already-admitted save without racing the actual upstream write.
 */
export function runHermesDashboardMutation<T>(
  workspaceId: string,
  agentId: string,
  writeLease: HermesRuntimeWriteLease,
  operation: (ready: { port?: number; error?: string }) => Promise<T>,
): Promise<T | undefined> {
  if (!holdsHermesRuntimeWriteLease(workspaceId, agentId, writeLease)) {
    return Promise.reject(new Error('The Hermes dashboard write lease is invalid or expired.'));
  }
  return enqueueHermesOperation(
    workspaceId,
    agentId,
    undefined as T | undefined,
    async () => operation(await ensureHermesDashboardReadyUnlocked(workspaceId, agentId)),
    { writeLease },
  );
}

/**
 * Acquire both runtime queues in a stable order. A volume copy temporarily
 * stops the source and prepares the target, so it must not race a sync,
 * readiness check, or cleanup on either agent.
 */
function enqueueHermesPairOperation<T>(
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
  rejected: T,
  operation: () => Promise<T>,
): Promise<T> {
  if (sourceAgentId === targetAgentId) return Promise.resolve(rejected);
  const [firstAgentId, secondAgentId] = [sourceAgentId, targetAgentId].sort();
  return enqueueHermesOperation(
    workspaceId,
    firstAgentId,
    rejected,
    () => enqueueHermesOperation(
      workspaceId,
      secondAgentId,
      rejected,
      operation,
      { bypassRuntimeAccessGate: true },
    ),
    { bypassRuntimeAccessGate: true },
  );
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runDocker(
  args: string[],
  input?: string,
  timeoutMs = DOCKER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: dockerEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `docker exited with code ${code}`));
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
  const configured = runtimeEnv('TOOLPLANE_HERMES_CALLBACK_URL')
    || runtimeEnv('NEXT_PUBLIC_APP_URL')
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

async function validateHermesConfigCompatibility(params: {
  image: string;
  sandboxId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await runDocker([
    'run', '--rm', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'hermes',
    ...HERMES_SYNC_CONTAINER_RESOURCE_LIMITS,
    '-v', `${sandboxVolumeName(params.sandboxId)}:/opt/data:ro`,
    '--env', 'HERMES_HOME=/opt/data',
    '--entrypoint', '/opt/hermes/.venv/bin/python',
    params.image,
    '-c', CONFIG_COMPATIBILITY_SCRIPT,
  ], undefined, DOCKER_TIMEOUT_MS, params.signal);
}

function renderManagedHermesConfig(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
): string {
  if (!agent.runtime) throw new Error('Hermes runtime is not configured.');
  return renderHermesConfig({
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
    systemPrompt: agent.publicRuntimeAllocation?.revision.systemPrompt,
    publicRuntime: Boolean(agent.publicRuntimeAllocation),
  });
}

async function buildProjection(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
): Promise<{ directory: string; configHash: string }> {
  if (!agent.runtime) throw new Error('Hermes runtime is not configured.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'toolplane-hermes-'));
  const hash = createHash('sha256');
  const resolved = resolveAgentTools(agent);
  const config = renderManagedHermesConfig(agent);
  const runtimeEnvironment = readSandboxEnv(agent.runtime.sandbox.config);
  const projectedEnvironment = {
    ...runtimeEnvironment,
    API_SERVER_KEY: deriveHermesRuntimeToken(agent.runtime.id, 'hermes-api'),
  };
  const envPayload = renderHermesEnvPayload(projectedEnvironment);
  const profileEnvPayload = renderHermesEnvPayload({
    API_SERVER_KEY: deriveHermesRuntimeToken(agent.runtime.id, 'hermes-api'),
  });
  await writeFile(path.join(directory, 'config.yaml'), config, { mode: 0o600 });
  await writeFile(path.join(directory, 'env.json'), envPayload, { mode: 0o600 });
  await writeFile(path.join(directory, 'profile-env.json'), profileEnvPayload, { mode: 0o600 });
  await writeFile(
    path.join(directory, '.toolplane-merge-config.py'),
    CONFIG_MERGE_SCRIPT,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, '.toolplane-merge-env.py'),
    HERMES_ENV_MERGE_SCRIPT,
    { mode: 0o600 },
  );
  hash.update(config);
  // Native channel values are merely a one-time compatibility seed; Hermes'
  // volume owns them afterwards, so they must not keep invalidating the
  // ToolPlane projection fingerprint.
  hash.update(`env\0${renderHermesEnvPayload(withoutHermesChannelEnv(projectedEnvironment))}\0`);
  hash.update(`profile-env\0${profileEnvPayload}\0`);
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

export async function syncHermesProfileProjection(
  workspaceId: string,
  agentId: string,
  profile: string,
  writeLease: HermesRuntimeWriteLease,
): Promise<boolean> {
  if (profile === 'default') return true;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) return false;
  const projected = await runHermesDashboardMutation(
    workspaceId,
    agentId,
    writeLease,
    async (ready) => {
      if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');
      const agent = await getAgent(workspaceId, agentId);
      if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) return false;
      const profileDirectory = `/opt/data/profiles/${profile}`;
      const configPath = `${profileDirectory}/config.yaml`;
      const envPath = `${profileDirectory}/.env`;
      const container = sandboxContainerName(agent.runtime.sandboxId);
      try {
        await runDocker(['exec', container, 'test', '-d', profileDirectory], undefined, 30_000);
      } catch {
        throw new Error('Hermes profile does not exist.');
      }
      await runDocker(
        ['exec', '--user', 'hermes', container, '/opt/hermes/.venv/bin/python', '-c', CONFIG_COMPATIBILITY_SCRIPT, configPath],
        undefined,
        30_000,
      );
      await runDocker(
        ['exec', '--user', 'hermes', '-i', container, '/opt/hermes/.venv/bin/python', '-c', CONFIG_MERGE_SCRIPT, configPath, '-'],
        renderManagedHermesConfig(agent),
        30_000,
      );
      await runDocker(
        ['exec', '--user', 'hermes', '-i', container, '/opt/hermes/.venv/bin/python', '-c', HERMES_ENV_MERGE_SCRIPT, envPath, '-'],
        renderHermesEnvPayload({
          API_SERVER_KEY: deriveHermesRuntimeToken(agent.runtime.id, 'hermes-api'),
        }),
        30_000,
      );
      return true;
    },
  );
  return projected === true;
}

async function installProjection(params: {
  directory: string;
  image: string;
  sandboxId: string;
  signal?: AbortSignal;
}) {
  const volume = sandboxVolumeName(params.sandboxId);
  const initContainer = sandboxSyncContainerName(params.sandboxId);
  const hermesOwnedPaths = [
    '/opt/data/config.yaml',
    '/opt/data/.env',
    '/opt/data/.toolplane-env-keys.json',
    '/opt/data/SOUL.md',
    '/opt/data/cron',
    '/opt/data/sessions',
    '/opt/data/logs',
    '/opt/data/memories',
    '/opt/data/pairing',
    '/opt/data/hooks',
    '/opt/data/image_cache',
    '/opt/data/audio_cache',
    '/opt/data/profiles',
    '/opt/data/skills',
    '/opt/data/skill-bundles',
  ].join(' ');
  await runDocker(['volume', 'create', volume], undefined, DOCKER_TIMEOUT_MS, params.signal);
  params.signal?.throwIfAborted();
  await runDocker(['rm', '-f', initContainer]).catch(() => undefined);
  const installCommand = [
    'set -eu',
    `rm -rf /opt/data/skills/${TOOLPLANE_SKILL_ROOT} /opt/data/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml`,
    'mkdir -p /opt/data/skills /opt/data/skill-bundles',
    `if [ -d /tmp/toolplane/skills/${TOOLPLANE_SKILL_ROOT} ]; then cp -R /tmp/toolplane/skills/${TOOLPLANE_SKILL_ROOT} /opt/data/skills/; fi`,
    `if [ -f /tmp/toolplane/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml ]; then cp /tmp/toolplane/skill-bundles/${TOOLPLANE_SKILL_ROOT}.yaml /opt/data/skill-bundles/; fi`,
    '/opt/hermes/.venv/bin/python /tmp/toolplane/.toolplane-merge-config.py /opt/data/config.yaml /tmp/toolplane/config.yaml',
    '/opt/hermes/.venv/bin/python -c "from hermes_cli import config; migrate = getattr(config, \'migrate_config\', None); migrate(interactive=False, quiet=True) if callable(migrate) else None"',
    '/opt/hermes/.venv/bin/python /tmp/toolplane/.toolplane-merge-env.py /opt/data/.env /tmp/toolplane/env.json',
    'for profile in /opt/data/profiles/*; do [ -d "$profile" ] || continue; name=${profile##*/}; [ ${#name} -le 64 ] || continue; case "$name" in [a-z0-9]*) ;; *) continue ;; esac; case "$name" in *[!a-z0-9_-]*) continue ;; esac; /opt/hermes/.venv/bin/python /tmp/toolplane/.toolplane-merge-config.py "$profile/config.yaml" /tmp/toolplane/config.yaml; /opt/hermes/.venv/bin/python /tmp/toolplane/.toolplane-merge-env.py "$profile/.env" /tmp/toolplane/profile-env.json; done',
    `if id hermes >/dev/null 2>&1; then for path in ${hermesOwnedPaths}; do [ ! -e "$path" ] || chown -R "$(id -u hermes):$(id -g hermes)" "$path"; done; chown -R "$(id -u hermes):$(id -g hermes)" /opt/data/workspace 2>/dev/null || true; fi`,
  ].join(' && ');
  await runDocker([
    'create', '--name', initContainer, '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges',
    ...HERMES_SYNC_CONTAINER_RESOURCE_LIMITS,
    '--env', 'HERMES_HOME=/opt/data',
    '-v', `${volume}:/opt/data`, '--entrypoint', '/bin/sh', params.image, '-c', installCommand,
  ], undefined, DOCKER_TIMEOUT_MS, params.signal);
  try {
    await runDocker(
      ['cp', `${params.directory}/.`, `${initContainer}:/tmp/toolplane`],
      undefined,
      DOCKER_TIMEOUT_MS,
      params.signal,
    );
    await runDocker(
      ['start', '--attach', initContainer],
      undefined,
      DOCKER_TIMEOUT_MS,
      params.signal,
    );
  } finally {
    await runDocker(['rm', '-f', initContainer]).catch(() => undefined);
  }
}

async function removeHermesContainerStrict(sandboxId: string): Promise<void> {
  try {
    await runDocker(['rm', '-f', sandboxContainerName(sandboxId)]);
  } catch (error) {
    // A missing container is the desired postcondition. Every other Docker
    // failure must abort the rebuild so the old container cannot be reused
    // with stale in-memory configuration.
    if (/no such container/i.test(copyErrorMessage(error))) return;
    throw error;
  }
}

// Importing an existing Hermes home must go through `docker cp`, not a bind
// mount: production uses a remote Docker socket proxy, so app-container paths
// are not paths on the Docker daemon host. The staged directory is already
// sanitized by the archive importer before it reaches this helper.
export async function copyHermesArchiveToVolume(params: {
  directory: string;
  image: string;
  sandboxId: string;
}): Promise<void> {
  const volume = sandboxVolumeName(params.sandboxId);
  const initContainer = sandboxSyncContainerName(params.sandboxId);
  await runDocker(['volume', 'create', volume]);
  await runDocker(
    ['rm', '-f', initContainer],
    undefined,
    HERMES_ARCHIVE_COPY_TIMEOUT_MS,
  ).catch(() => undefined);

  const installCommand = [
    'set -eu',
    'mkdir -p /opt/data',
    'cp -R /tmp/toolplane-import/. /opt/data/',
    'if id hermes >/dev/null 2>&1; then chown -R "$(id -u hermes):$(id -g hermes)" /opt/data; fi',
  ].join(' && ');
  await runDocker([
    'create', '--name', initContainer, '--network', 'none',
    '--label', 'toolplane.hermes-archive-import=true',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges',
    ...HERMES_SYNC_CONTAINER_RESOURCE_LIMITS,
    '-v', `${volume}:/opt/data`, '--entrypoint', '/bin/sh', params.image, '-c', installCommand,
  ]);
  try {
    await runDocker(
      ['cp', `${params.directory}/.`, `${initContainer}:/tmp/toolplane-import`],
      undefined,
      HERMES_ARCHIVE_COPY_TIMEOUT_MS,
    );
    await runDocker(['start', '--attach', initContainer], undefined, HERMES_ARCHIVE_COPY_TIMEOUT_MS);
  } finally {
    await runDocker(
      ['rm', '-f', initContainer],
      undefined,
      HERMES_ARCHIVE_COPY_TIMEOUT_MS,
    ).catch(() => undefined);
  }
}

async function updateRuntimeState(
  workspaceId: string,
  runtimeId: string,
  data: Prisma.AgentRuntimeUpdateManyMutationInput,
) {
  await db.agentRuntime.updateMany({ where: { id: runtimeId, workspaceId }, data });
}

async function startHermesProcess(
  workspaceId: string,
  agentId: string,
  deployment: Parameters<typeof resolveSpawnSpec>[0] & { id: string },
): Promise<void> {
  await startProcess(deployment.id, resolveSpawnSpec(deployment), {
    awaitReady: false,
    workspaceId,
    onReady: async () => { await ensureHermesRuntimeReady(workspaceId, agentId); },
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hermesInstallConfigWithImage(params: {
  installCfg: unknown;
  image: string;
  sandboxId: string;
  runtimeId: string;
  runtimeModelName: string;
  env: Record<string, string>;
}): Prisma.InputJsonObject {
  // Preserve any forward-compatible sandbox fields while restoring every
  // ToolPlane-owned Hermes field. This protects an older/incomplete runtime
  // row from starting with an old image after an upgrade.
  const existing = (isJsonRecord(params.installCfg) ? params.installCfg : {}) as Prisma.InputJsonObject;
  return {
    ...existing,
    sandboxId: params.sandboxId,
    kind: HERMES_RUNTIME_KIND,
    image: params.image,
    network: 'isolated',
    volumeName: sandboxVolumeName(params.sandboxId),
    runtimeId: params.runtimeId,
    runtimeModelName: params.runtimeModelName,
    env: params.env,
  };
}

async function setHermesRuntimeUpgradePending(
  workspaceId: string,
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
  image: string,
): Promise<void> {
  const runtime = agent.runtime;
  if (!runtime || runtime.kind !== HERMES_RUNTIME_KIND) {
    throw new Error('Hermes runtime is not configured.');
  }

  const installCfg = hermesInstallConfigWithImage({
    installCfg: runtime.sandbox.deployment.installCfg,
    image,
    sandboxId: runtime.sandboxId,
    runtimeId: runtime.id,
    runtimeModelName: agent.slug,
    env: withoutHermesChannelEnv(readSandboxEnv(runtime.sandbox.config)),
  });

  await db.$transaction(async (tx) => {
    const [runtimeUpdate, sandboxUpdate, deploymentUpdate] = await Promise.all([
      tx.agentRuntime.updateMany({
        where: {
          id: runtime.id,
          workspaceId,
          agentId: agent.id,
          sandboxId: runtime.sandboxId,
          kind: HERMES_RUNTIME_KIND,
        },
        data: {
          image,
          status: 'upgrading',
          configHash: null,
          lastError: null,
        },
      }),
      tx.sandbox.updateMany({
        where: {
          id: runtime.sandboxId,
          workspaceId,
          kind: HERMES_RUNTIME_KIND,
        },
        data: { image },
      }),
      tx.deployment.updateMany({
        where: {
          id: runtime.sandbox.deploymentId,
          workspaceId,
          source: 'sandbox',
        },
        data: {
          sourceRef: image,
          installCfg,
          status: 'upgrading',
        },
      }),
    ]);
    if (runtimeUpdate.count !== 1 || sandboxUpdate.count !== 1 || deploymentUpdate.count !== 1) {
      throw new Error('The Hermes runtime changed before its image could be upgraded.');
    }
  });
}

export type HermesRuntimeVolumeCopyResult<T = undefined> =
  | {
      status: 'copied';
      data?: T;
      // A source restart failure must not turn a completed target copy into a
      // false negative. The source runtime is marked with this error as well.
      sourceRestartError?: string;
    }
  | {
      status: 'error';
      error: string;
    };

function copyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 4000) || 'Could not copy the Hermes runtime volume.';
}

function isMissingDockerVolume(error: unknown): boolean {
  return /no such volume/i.test(copyErrorMessage(error));
}

export type HermesRuntimeMaintenanceOptions = {
  /**
   * A snapshot or restore needs a stopped volume. Snapshot deletion only needs
   * the lease/queue so it cannot race a restore or clone.
   */
  quiesce?: boolean;
  /** Persisted while the volume is unavailable, including across app workers. */
  operationStatus?: 'copying' | 'restoring';
  /**
   * A restored volume may contain an old ToolPlane MCP token, provider
   * projection, skill bundle, or .env. Reproject those managed files before
   * exposing the runtime again.
   */
  reprojectAfter?: boolean;
  /** Recovery snapshots and their deletion stay available after a failed restore. */
  allowRestoreFailed?: boolean;
};

export type HermesRuntimeMaintenanceContext = {
  agentId: string;
  runtimeId: string;
  sandboxId: string;
  deploymentId: string;
  volumeName: string;
  wasActive: boolean;
  /** Hash-check and synchronize ToolPlane-managed files before reopening writes. */
  requestSync: () => void;
  /** Keep an unsafe restore stopped; the caller persists its recovery state. */
  preventResume: () => void;
};

export type HermesRuntimeMaintenanceResult<T> =
  | { status: 'completed'; data: T }
  | { status: 'error'; error: string };

function isWorkspaceOwnedHermesRuntime(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>> | null,
  workspaceId: string,
  agentId: string,
  sandboxId: string,
): agent is NonNullable<Awaited<ReturnType<typeof getAgent>>> & {
  runtime: NonNullable<NonNullable<Awaited<ReturnType<typeof getAgent>>>['runtime']>;
} {
  const runtime = agent?.runtime;
  return Boolean(
    agent
    && runtime
    && agent.id === agentId
    && agent.workspaceId === workspaceId
    && runtime.id
    && runtime.kind === HERMES_RUNTIME_KIND
    && runtime.workspaceId === workspaceId
    && runtime.sandboxId === sandboxId
    && runtime.sandbox.id === sandboxId
    && runtime.sandbox.workspaceId === workspaceId
    && runtime.sandbox.deployment.workspaceId === workspaceId
    && runtime.sandbox.deployment.source === 'sandbox',
  );
}

/**
 * Run a volume operation for one managed Hermes runtime.
 *
 * This deliberately shares the clone/upgrade maintenance lease: it first
 * drains admitted chat/attachment writes, rejects new writes, and then enters
 * the per-agent lifecycle queue. Callers own their snapshot database rows and
 * may use `preventResume` when rollback cannot establish a safe volume.
 */
export async function runHermesRuntimeMaintenance<T>(
  workspaceId: string,
  agentId: string,
  sandboxId: string,
  options: HermesRuntimeMaintenanceOptions,
  operation: (context: HermesRuntimeMaintenanceContext) => Promise<T>,
): Promise<HermesRuntimeMaintenanceResult<T>> {
  let releaseMaintenanceLease: (() => void) | undefined;
  try {
    releaseMaintenanceLease = await acquireHermesRuntimeUpgradeLease(workspaceId, agentId);
  } catch (error) {
    return { status: 'error', error: copyErrorMessage(error) };
  }

  const rejected: HermesRuntimeMaintenanceResult<T> = {
    status: 'error',
    error: SANDBOX_LIFECYCLE_ERROR,
  };
  try {
    return await enqueueHermesOperation(
      workspaceId,
      agentId,
      rejected,
      () => runHermesRuntimeMaintenanceUnlocked(
        workspaceId,
        agentId,
        sandboxId,
        options,
        operation,
      ),
      { bypassRuntimeAccessGate: true },
    );
  } finally {
    releaseMaintenanceLease();
  }
}

async function runHermesRuntimeMaintenanceUnlocked<T>(
  workspaceId: string,
  agentId: string,
  sandboxId: string,
  options: HermesRuntimeMaintenanceOptions,
  operation: (context: HermesRuntimeMaintenanceContext) => Promise<T>,
): Promise<HermesRuntimeMaintenanceResult<T>> {
  const agent = await getAgent(workspaceId, agentId);
  if (!isWorkspaceOwnedHermesRuntime(agent, workspaceId, agentId, sandboxId)) {
    return { status: 'error', error: 'Hermes runtime not found.' };
  }

  const runtime = agent.runtime;
  const deployment = runtime.sandbox.deployment;
  const effective = effectiveStatus(deployment.id, deployment.status);
  const allowsRestoreRecovery = options.allowRestoreFailed ?? false;
  if (
    (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(deployment.status)
      && !(allowsRestoreRecovery && deployment.status === 'restore_failed'))
    || (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(effective)
      && !(allowsRestoreRecovery && effective === 'restore_failed'))
  ) {
    return { status: 'error', error: SANDBOX_LIFECYCLE_ERROR };
  }

  const quiesce = options.quiesce ?? false;
  const operationStatus = options.operationStatus ?? 'copying';
  const wasActive = effective === 'running' || effective === 'provisioning';
  const originalDeploymentStatus = deployment.status;
  const originalRuntimeStatus = runtime.status;
  let resumeAllowed = true;
  let syncAfter = false;
  const context: HermesRuntimeMaintenanceContext = {
    agentId,
    runtimeId: runtime.id,
    sandboxId: runtime.sandboxId,
    deploymentId: deployment.id,
    volumeName: sandboxVolumeName(runtime.sandboxId),
    wasActive,
    requestSync: () => { syncAfter = true; },
    preventResume: () => { resumeAllowed = false; },
  };
  let maintenancePrepared = false;
  let quiesceAttempted = false;
  let reprojected = false;
  let completed = false;
  let result: HermesRuntimeMaintenanceResult<T>;

  try {
    if (quiesce) {
      const [deploymentUpdate, runtimeUpdate] = await Promise.all([
        db.deployment.updateMany({
          where: {
            id: deployment.id,
            workspaceId,
            source: 'sandbox',
            status: originalDeploymentStatus,
          },
          data: { status: operationStatus },
        }),
        db.agentRuntime.updateMany({
          where: {
            id: runtime.id,
            workspaceId,
            agentId,
            sandboxId: runtime.sandboxId,
            kind: HERMES_RUNTIME_KIND,
          },
          data: { status: operationStatus, lastError: null },
        }),
      ]);
      if (deploymentUpdate.count !== 1 || runtimeUpdate.count !== 1) {
        throw new Error('The Hermes runtime changed before its volume operation could begin.');
      }
      maintenancePrepared = true;
      dashboardReadyCache().delete(deployment.id);
      quiesceAttempted = true;
      await killProcess(deployment.id, { finalStatus: operationStatus });
      await stopDockerSandboxContainer(runtime.sandboxId);
    }

    const data = await operation(context);

    if (options.reprojectAfter) {
      // Volume restoration also restores prior ToolPlane-managed files. Force
      // the projection path even when the database still has the same hash.
      const invalidated = await db.agentRuntime.updateMany({
        where: {
          id: runtime.id,
          workspaceId,
          agentId,
          sandboxId: runtime.sandboxId,
          kind: HERMES_RUNTIME_KIND,
        },
        data: { configHash: null, configVersion: 0, lastError: null },
      });
      if (invalidated.count !== 1) {
        throw new Error('The Hermes runtime changed before its restored volume could be projected.');
      }
    }
    if (options.reprojectAfter || syncAfter) {
      // A failed sync has already persisted a safe error state. Do not blindly
      // launch the old container from the finally block.
      resumeAllowed = false;
      const synced = await syncHermesRuntimeUnlocked(workspaceId, agentId, {
        start: wasActive,
        allowRestoring: operationStatus === 'restoring',
        preserveStoppedWhenNotStarting: true,
      });
      if (synced.error) throw new Error(synced.error);
      reprojected = true;
    }

    completed = true;
    result = { status: 'completed', data };
  } catch (error) {
    result = { status: 'error', error: copyErrorMessage(error) };
  } finally {
    if (quiesce && !reprojected && resumeAllowed) {
      if (wasActive && quiesceAttempted) {
        try {
          await startHermesProcess(workspaceId, agentId, deployment);
          await updateRuntimeState(workspaceId, runtime.id, {
            status: 'provisioning',
            lastError: null,
          });
        } catch (error) {
          const message = `The Hermes runtime could not be restarted after a volume operation: ${copyErrorMessage(error)}`
            .slice(0, 4000);
          await Promise.all([
            db.deployment.updateMany({
              where: { id: deployment.id, workspaceId, source: 'sandbox' },
              data: { status: 'error' },
            }).catch(() => undefined),
            updateRuntimeState(workspaceId, runtime.id, {
              status: 'error',
              lastError: message,
            }).catch(() => undefined),
          ]);
          result = { status: 'error', error: message };
        }
      } else if (!wasActive) {
        // On success a deliberately stopped runtime stays stopped. On a safe
        // failed restore/snapshot, return to the state that preceded the
        // maintenance marker. Callers that could not restore a safe volume use
        // preventResume() and persist restore_failed/cleanup_required instead.
        const deploymentStatus = completed ? 'stopped' : originalDeploymentStatus;
        const runtimeStatus = completed
          ? agent.modelProviders.length > 0 ? 'stopped' : 'setup_required'
          : originalRuntimeStatus;
        await Promise.all([
          db.deployment.updateMany({
            where: { id: deployment.id, workspaceId, source: 'sandbox' },
            data: { status: deploymentStatus },
          }).catch(() => undefined),
          updateRuntimeState(workspaceId, runtime.id, {
            status: runtimeStatus,
            lastError: completed ? null : runtime.lastError,
          }).catch(() => undefined),
        ]);
      } else if (!quiesceAttempted && maintenancePrepared) {
        await Promise.all([
          db.deployment.updateMany({
            where: { id: deployment.id, workspaceId, source: 'sandbox' },
            data: { status: originalDeploymentStatus },
          }).catch(() => undefined),
          updateRuntimeState(workspaceId, runtime.id, {
            status: originalRuntimeStatus,
          }).catch(() => undefined),
        ]);
      }
    }
  }
  return result!;
}

/**
 * Copies the persistent data volume between two workspace-owned Hermes
 * runtimes. `afterCopy` runs while the source is quiesced, after its volume
 * is copied but before it is resumed. Callers use it to atomically map
 * database records (conversations and attachments) to the copied files.
 * The caller must run syncHermesRuntime for the target afterwards: sync
 * regenerates the target's runtime-scoped MCP token, provider projection, and
 * ToolPlane-managed skills.
 */
export async function copyHermesRuntimeVolume<T = undefined>(
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
  afterCopy?: () => Promise<T>,
): Promise<HermesRuntimeVolumeCopyResult<T>> {
  const invalid: HermesRuntimeVolumeCopyResult<T> = {
    status: 'error' as const,
    error: 'Source and target must be distinct Hermes agents in this workspace.',
  };
  if (sourceAgentId === targetAgentId) return invalid;

  // Close and drain the access gates *before* taking either lifecycle queue.
  // An admitted chat can still call ensure with its lease, whereas a new
  // readiness/sync request cannot get in front of the pending copy.
  const releaseCopyLeases = await acquireHermesRuntimePairCopyLeases(
    workspaceId,
    sourceAgentId,
    targetAgentId,
  );
  try {
    return await enqueueHermesPairOperation(
      workspaceId,
      sourceAgentId,
      targetAgentId,
      invalid,
      () => copyHermesRuntimeVolumeUnlocked(workspaceId, sourceAgentId, targetAgentId, afterCopy),
    );
  } finally {
    releaseCopyLeases();
  }
}

async function copyHermesRuntimeVolumeUnlocked<T>(
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
  afterCopy?: () => Promise<T>,
): Promise<HermesRuntimeVolumeCopyResult<T>> {
  const [sourceAgent, targetAgent] = await Promise.all([
    getAgent(workspaceId, sourceAgentId),
    getAgent(workspaceId, targetAgentId),
  ]);
  const sourceRuntime = sourceAgent?.runtime;
  const targetRuntime = targetAgent?.runtime;
  if (
    !sourceAgent
    || !targetAgent
    || !sourceRuntime
    || !targetRuntime
    || sourceAgent.workspaceId !== workspaceId
    || targetAgent.workspaceId !== workspaceId
    || sourceRuntime.workspaceId !== workspaceId
    || targetRuntime.workspaceId !== workspaceId
    || sourceRuntime.kind !== HERMES_RUNTIME_KIND
    || targetRuntime.kind !== HERMES_RUNTIME_KIND
    || sourceRuntime.sandbox.workspaceId !== workspaceId
    || targetRuntime.sandbox.workspaceId !== workspaceId
    || sourceRuntime.sandbox.deployment.workspaceId !== workspaceId
    || targetRuntime.sandbox.deployment.workspaceId !== workspaceId
    || sourceRuntime.sandbox.deployment.source !== 'sandbox'
    || targetRuntime.sandbox.deployment.source !== 'sandbox'
  ) {
    return {
      status: 'error',
      error: 'Source and target must be workspace-owned Hermes runtimes.',
    };
  }

  const sourceDeployment = sourceRuntime.sandbox.deployment;
  const targetDeployment = targetRuntime.sandbox.deployment;
  const sourceStatus = effectiveStatus(sourceDeployment.id, sourceDeployment.status);
  const targetStatus = effectiveStatus(targetDeployment.id, targetDeployment.status);
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(sourceDeployment.status)
    || BLOCKED_SANDBOX_LIFECYCLE_STATES.has(sourceStatus)) {
    return { status: 'error', error: SANDBOX_LIFECYCLE_ERROR };
  }
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(targetDeployment.status)
    || BLOCKED_SANDBOX_LIFECYCLE_STATES.has(targetStatus)) {
    return { status: 'error', error: 'The target Hermes sandbox has a pending lifecycle operation.' };
  }

  // The operation is intentionally destructive to its destination volume on a
  // failed copy. Only accept an untouched runtime created for this clone.
  if (
    targetDeployment.status !== 'stopped'
    || targetStatus !== 'stopped'
    || targetRuntime.configHash !== null
    || targetRuntime.lastSyncedAt !== null
  ) {
    return {
      status: 'error',
      error: 'The target Hermes runtime must be newly created and stopped before copying its volume.',
    };
  }

  const sourceWasLive = sourceStatus === 'running' || sourceStatus === 'provisioning';
  const sourceVolume = sandboxVolumeName(sourceRuntime.sandboxId);
  const targetVolume = sandboxVolumeName(targetRuntime.sandboxId);
  const targetRuntimeStatus = targetAgent.modelProviders.length > 0
    ? 'stopped'
    : 'setup_required';
  let sourceQuiesceAttempted = false;
  let result: HermesRuntimeVolumeCopyResult<T>;

  try {
    const [targetDeploymentUpdate, targetRuntimeUpdate] = await Promise.all([
      db.deployment.updateMany({
        where: {
          id: targetDeployment.id,
          workspaceId,
          source: 'sandbox',
          status: 'stopped',
        },
        data: { status: 'copying' },
      }),
      db.agentRuntime.updateMany({
        where: {
          id: targetRuntime.id,
          workspaceId,
          agentId: targetAgentId,
          sandboxId: targetRuntime.sandboxId,
          kind: HERMES_RUNTIME_KIND,
        },
        data: { status: 'copying', lastError: null },
      }),
    ]);
    if (targetDeploymentUpdate.count !== 1 || targetRuntimeUpdate.count !== 1) {
      throw new Error('The target Hermes runtime changed before its volume could be copied.');
    }
    const sourceRuntimeUpdate = await db.agentRuntime.updateMany({
      where: {
        id: sourceRuntime.id,
        workspaceId,
        agentId: sourceAgentId,
        sandboxId: sourceRuntime.sandboxId,
        kind: HERMES_RUNTIME_KIND,
      },
      data: { status: 'copying' },
    });
    if (sourceRuntimeUpdate.count !== 1) {
      throw new Error('The source Hermes runtime changed before its volume could be copied.');
    }

    // From this point the source runtime is marked unavailable even if a stop
    // command fails, so the recovery branch below restores a coherent status.
    sourceQuiesceAttempted = true;
    // Persist the maintenance state so requests from another app process are
    // rejected while this process holds the in-memory paired runtime locks.
    await killProcess(sourceDeployment.id, { finalStatus: 'copying' });
    await stopDockerSandboxContainer(sourceRuntime.sandboxId);
    try {
      await copyDockerVolume(sourceVolume, targetVolume);
    } catch (error) {
      // A fresh Hermes agent has no volume until its first projection sync.
      // Treat that as an empty, valid source snapshot rather than a failed
      // clone. Any other Docker error remains fatal.
      if (!isMissingDockerVolume(error)) throw error;
    }
    const data = afterCopy ? await afterCopy() : undefined;

    const [targetDeploymentReady, targetRuntimeReady] = await Promise.all([
      db.deployment.updateMany({
        where: { id: targetDeployment.id, workspaceId, source: 'sandbox' },
        data: { status: 'stopped' },
      }),
      db.agentRuntime.updateMany({
        where: { id: targetRuntime.id, workspaceId, agentId: targetAgentId },
        data: {
          status: targetRuntimeStatus,
          configVersion: 1,
          configHash: null,
          lastSyncedAt: null,
          lastStartedAt: null,
          lastError: null,
        },
      }),
    ]);
    if (targetDeploymentReady.count !== 1 || targetRuntimeReady.count !== 1) {
      throw new Error('The copied Hermes runtime could not be finalized.');
    }
    result = data === undefined ? { status: 'copied' } : { status: 'copied', data };
  } catch (error) {
    const copyError = copyErrorMessage(error);
    let cleanupError: string | null = null;
    try {
      await removeDockerSandboxRuntimeStrict(targetRuntime.sandboxId, targetVolume);
    } catch (cleanup) {
      cleanupError = copyErrorMessage(cleanup);
    }
    const message = cleanupError
      ? `${copyError} Cleanup of the partial target volume also failed: ${cleanupError}`.slice(0, 4000)
      : copyError;
    const cleanupSucceeded = cleanupError === null;
    await Promise.all([
      db.deployment.updateMany({
        where: { id: targetDeployment.id, workspaceId, source: 'sandbox' },
        data: { status: cleanupSucceeded ? 'stopped' : 'copy_failed' },
      }).catch(() => undefined),
      db.agentRuntime.updateMany({
        where: { id: targetRuntime.id, workspaceId, agentId: targetAgentId },
        data: cleanupSucceeded
          ? {
              status: targetRuntimeStatus,
              configHash: null,
              lastSyncedAt: null,
              lastStartedAt: null,
              lastError: message,
            }
          : { status: 'error', lastError: message },
      }).catch(() => undefined),
    ]);
    result = { status: 'error', error: message };
  }

  if (!sourceQuiesceAttempted) return result;
  if (!sourceWasLive) {
    const sourceRuntimeStatus = sourceRuntime.status === 'setup_required' || sourceRuntime.status === 'error'
      ? sourceRuntime.status
      : 'stopped';
    await Promise.all([
      db.deployment.updateMany({
        where: { id: sourceDeployment.id, workspaceId, source: 'sandbox' },
        data: { status: sourceDeployment.status === 'error' ? 'error' : 'stopped' },
      }).catch(() => undefined),
      updateRuntimeState(workspaceId, sourceRuntime.id, { status: sourceRuntimeStatus }).catch(() => undefined),
    ]);
    return result;
  }
  try {
    await startHermesProcess(workspaceId, sourceAgentId, sourceDeployment);
    await updateRuntimeState(workspaceId, sourceRuntime.id, {
      status: 'provisioning',
      lastError: null,
    }).catch(() => undefined);
  } catch (error) {
    const restartError = copyErrorMessage(error);
    const message = `The source Hermes runtime could not be restarted after a volume copy: ${restartError}`
      .slice(0, 4000);
    await Promise.all([
      db.deployment.updateMany({
        where: { id: sourceDeployment.id, workspaceId, source: 'sandbox' },
        data: { status: 'error' },
      }).catch(() => undefined),
      updateRuntimeState(workspaceId, sourceRuntime.id, {
        status: 'error',
        lastError: message,
      }).catch(() => undefined),
    ]);
    if (result.status === 'copied') return { ...result, sourceRestartError: message };
    return { status: 'error', error: `${result.error} ${message}`.slice(0, 4000) };
  }
  return result;
}

export type HermesRuntimeUpgradeResult = {
  status: string;
  image?: string;
  error?: string;
};

/**
 * Switch a managed runtime to an image (including refreshing the same mutable
 * tag). Pull happens before the runtime is stopped, so a failed registry
 * download leaves the currently running container and its persisted image
 * reference untouched.
 */
export async function upgradeHermesRuntime(
  workspaceId: string,
  agentId: string,
  rawImage: unknown,
): Promise<HermesRuntimeUpgradeResult> {
  const image = String(rawImage ?? '').trim();
  if (!isValidHermesImage(image)) {
    return { status: 'error', error: 'Enter a valid Docker image reference.' };
  }

  const current = await getAgent(workspaceId, agentId);
  if (!current?.runtime || current.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { status: 'error', error: 'Hermes runtime not found.' };
  }
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(current.runtime.sandbox.deployment.status)) {
    return { status: current.runtime.sandbox.deployment.status, error: SANDBOX_LIFECYCLE_ERROR };
  }

  try {
    // Pull even if the literal image reference did not change: `:latest` and
    // other mutable tags otherwise keep Docker's cached digest indefinitely.
    await pullDockerImage(image, DOCKER_TIMEOUT_MS);
  } catch (error) {
    return {
      status: 'error',
      error: `Could not pull Hermes image: ${copyErrorMessage(error)}`,
    };
  }

  const releaseUpgradeLease = await acquireHermesRuntimeUpgradeLease(workspaceId, agentId);
  try {
    return await enqueueHermesOperation(
      workspaceId,
      agentId,
      { status: 'error', error: SANDBOX_LIFECYCLE_ERROR },
      () => upgradeHermesRuntimeUnlocked(workspaceId, agentId, image),
      { bypassRuntimeAccessGate: true },
    );
  } finally {
    releaseUpgradeLease();
  }
}

async function upgradeHermesRuntimeUnlocked(
  workspaceId: string,
  agentId: string,
  image: string,
): Promise<HermesRuntimeUpgradeResult> {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { status: 'error', error: 'Hermes runtime not found.' };
  }
  const runtime = agent.runtime;
  const deployment = runtime.sandbox.deployment;
  if (BLOCKED_SANDBOX_LIFECYCLE_STATES.has(deployment.status)) {
    return { status: deployment.status, error: SANDBOX_LIFECYCLE_ERROR };
  }

  let upgradePending = false;
  try {
    await validateHermesConfigCompatibility({
      image,
      sandboxId: runtime.sandboxId,
    });
    // A cached healthy dashboard port is tied to the old child/container.
    dashboardReadyCache().delete(deployment.id);
    await setHermesRuntimeUpgradePending(workspaceId, agent, image);
    upgradePending = true;

    // Forcefully tear down the old supervisor child and its container after
    // all image references point at the new image. The named data volume is
    // intentionally retained, then `sync` projects managed files into it.
    await killProcess(deployment.id, { finalStatus: 'upgrading' });
    await removeHermesContainerStrict(runtime.sandboxId);

    const synced = await syncHermesRuntimeUnlocked(workspaceId, agentId, {
      allowUpgrading: true,
    });
    return synced.error ? synced : { ...synced, image };
  } catch (error) {
    const message = copyErrorMessage(error);
    if (upgradePending) {
      await Promise.all([
        updateRuntimeState(workspaceId, runtime.id, { status: 'error', lastError: message })
          .catch(() => undefined),
        db.deployment.updateMany({
          where: { id: deployment.id, workspaceId, source: 'sandbox' },
          data: { status: 'error' },
        }).catch(() => undefined),
      ]);
    }
    return { status: 'error', error: message };
  }
}

type HermesRuntimeSyncOptions = {
  start?: boolean;
  signal?: AbortSignal;
  // Explicit operator syncs rebuild even when ToolPlane's projection hash is
  // unchanged. Hermes-owned files (for example channel settings) live in the
  // persistent volume and are intentionally not part of that hash.
  force?: boolean;
  // Only the image-upgrade operation may continue from its durable
  // `upgrading` marker; public sync callers must keep respecting it.
  allowUpgrading?: boolean;
  // A snapshot restore keeps this durable marker while it rebuilds managed
  // runtime files, so another app worker cannot start the half-restored
  // volume between copy and projection.
  allowRestoring?: boolean;
  // Internal restore callers preserve an intentionally stopped configured
  // runtime. Existing public `{ start: false }` callers retain their current
  // setup_required behaviour.
  preserveStoppedWhenNotStarting?: boolean;
};

export async function syncHermesRuntime(
  workspaceId: string,
  agentId: string,
  options: { start?: boolean; signal?: AbortSignal; force?: boolean } = {},
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
  options: HermesRuntimeSyncOptions = {},
): Promise<{ status: string; error?: string }> {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent?.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND) {
    return { status: 'native' };
  }
  const runtime = agent.runtime;
  const deploymentId = runtime.sandbox.deploymentId;
  const deploymentStatus = runtime.sandbox.deployment.status;
  if (
    BLOCKED_SANDBOX_LIFECYCLE_STATES.has(deploymentStatus)
    && !(options.allowUpgrading && deploymentStatus === 'upgrading')
    && !(options.allowRestoring && deploymentStatus === 'restoring')
  ) {
    return { status: deploymentStatus, error: SANDBOX_LIFECYCLE_ERROR };
  }
  let projection: Awaited<ReturnType<typeof buildProjection>> | null = null;

  try {
    options.signal?.throwIfAborted();
    projection = await buildProjection(agent);
    options.signal?.throwIfAborted();
    const configured = agent.modelProviders.length > 0;
    if (
      !options.force
      && projection.configHash === runtime.configHash
      && runtime.configVersion >= HERMES_CONFIG_VERSION
    ) {
      if (!configured || options.start === false) {
        const status = configured ? 'stopped' : 'setup_required';
        await updateRuntimeState(workspaceId, runtime.id, { status, lastError: null });
        return { status };
      }
      if (!livePort(deploymentId)) {
        options.signal?.throwIfAborted();
        await startHermesProcess(workspaceId, agentId, runtime.sandbox.deployment);
        await updateRuntimeState(workspaceId, runtime.id, {
          status: 'provisioning',
          lastStartedAt: new Date(),
          lastError: null,
        });
        return { status: 'provisioning' };
      }
      return { status: runtime.status };
    }

    // Keep the durable maintenance marker through the projection. Otherwise
    // this second stop would briefly persist `stopped`, allowing unrelated
    // sandbox lifecycle work to enter while managed files are being replaced.
    const preservedLifecycleStatus = options.allowUpgrading && deploymentStatus === 'upgrading'
      ? 'upgrading'
      : options.allowRestoring && deploymentStatus === 'restoring'
        ? 'restoring'
        : undefined;
    // Reject an explicitly ancient imported config before taking a currently
    // usable runtime down. Hermes deliberately retired those migrations, so
    // deleting or blindly bumping the version would risk corrupting channels
    // and provider settings.
    await validateHermesConfigCompatibility({
      image: runtime.image,
      sandboxId: runtime.sandboxId,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    dashboardReadyCache().delete(deploymentId);
    await killProcess(
      deploymentId,
      preservedLifecycleStatus
        ? { finalStatus: preservedLifecycleStatus }
        : undefined,
    );
    options.signal?.throwIfAborted();
    await removeHermesContainerStrict(runtime.sandboxId);
    options.signal?.throwIfAborted();
    await installProjection({
      directory: projection.directory,
      image: runtime.image,
      sandboxId: runtime.sandboxId,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();

    const nextStatus = configured
      ? options.start !== false ? 'provisioning' : options.preserveStoppedWhenNotStarting ? 'stopped' : 'setup_required'
      : 'setup_required';
    const launchEnvironment = withoutHermesChannelEnv(readSandboxEnv(runtime.sandbox.config));
    const launchInstallCfg = hermesInstallConfigWithImage({
      installCfg: runtime.sandbox.deployment.installCfg,
      image: runtime.image,
      sandboxId: runtime.sandboxId,
      runtimeId: runtime.id,
      runtimeModelName: agent.slug,
      // Channel credentials are owned by Hermes' persistent .env. Keeping a
      // second stale copy in Docker's inherited environment would let it win
      // before Hermes reloads the Dashboard-managed file.
      env: launchEnvironment,
    });
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
        data: {
          status: configured && options.start !== false ? 'provisioning' : 'stopped',
          installCfg: launchInstallCfg,
        },
      }),
      // Complete the one-time ownership migration after the persistent .env
      // merge succeeds. This removes stale channel duplicates from ToolPlane's
      // UI/database while leaving their effective values in Hermes' volume.
      db.sandbox.updateMany({
        where: { id: runtime.sandboxId, workspaceId },
        data: { config: sandboxConfigWithEnv(runtime.sandbox.config, launchEnvironment) ?? {} },
      }),
    ]);

    if (!configured || options.start === false) return { status: nextStatus };
    options.signal?.throwIfAborted();
    await startHermesProcess(workspaceId, agentId, runtime.sandbox.deployment);
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

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Operation aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function waitForHermesHealth(
  deploymentId: string,
  signal?: AbortSignal,
): Promise<{ port?: number; health?: HermesGatewayHealth }> {
  const deadline = Date.now() + 45_000;
  let latestHealth: HermesGatewayHealth | undefined;
  let defaultUpRequested = false;
  let nextDefaultUpAttemptAt = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const port = livePort(deploymentId);
    if (port) {
      try {
        const timeoutSignal = AbortSignal.timeout(5_000);
        const response = await fetch(`http://127.0.0.1:${port}/hermes/health/detailed`, {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
          cache: 'no-store',
        });
        if (response.ok) {
          const status = await response.json() as {
            gateway_state?: unknown;
            pid?: unknown;
            exit_reason?: unknown;
          };
          latestHealth = {
            gatewayState: typeof status.gateway_state === 'string' ? status.gateway_state : undefined,
            pid: Number.isInteger(status.pid) && Number(status.pid) > 0
              ? Number(status.pid)
              : undefined,
            exitReason: typeof status.exit_reason === 'string'
              ? status.exit_reason.slice(0, 500)
              : undefined,
          };
          if (
            latestHealth.gatewayState === 'running'
            && latestHealth.pid
          ) return { port, health: latestHealth };
        }
      } catch {
        signal?.throwIfAborted();
        // Gateway may still be booting or pulling the image.
      }
      signal?.throwIfAborted();
      if (!defaultUpRequested && Date.now() >= nextDefaultUpAttemptAt) {
        nextDefaultUpAttemptAt = Date.now() + 3_000;
        try {
          const timeoutSignal = AbortSignal.timeout(15_000);
          const response = await fetch(
            `http://127.0.0.1:${port}/hermes/control/gateway/default/up`,
            {
              method: 'POST',
              signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
              cache: 'no-store',
            },
          );
          defaultUpRequested = response.ok;
        } catch {
          signal?.throwIfAborted();
          // The Docker container may not accept exec yet. Retry on the next
          // bounded interval while the outer proxy remains available.
        }
      }
    }
    await abortableDelay(750, signal);
  }
  return { health: latestHealth };
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
  options: { writeLease?: HermesRuntimeWriteLease; signal?: AbortSignal } = {},
): Promise<{ port?: number; error?: string }> {
  return enqueueHermesOperation(
    workspaceId,
    agentId,
    { error: SANDBOX_LIFECYCLE_ERROR },
    () => {
      options.signal?.throwIfAborted();
      return ensureHermesRuntimeReadyUnlocked(workspaceId, agentId, options.signal);
    },
    { writeLease: options.writeLease },
  );
}

async function ensureHermesRuntimeReadyUnlocked(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<{ port?: number; error?: string }> {
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    await startProcess(
      deploymentId,
      resolveSpawnSpec(agent.runtime.sandbox.deployment),
      { awaitReady: false, workspaceId },
    );
  }
  const ready = await waitForHermesHealth(deploymentId, signal);
  if (!ready.port) {
    const detail = ready.health?.exitReason
      || (ready.health?.gatewayState ? `gateway state: ${ready.health.gatewayState}` : null);
    const message = detail
      ? `Hermes gateway did not become healthy within 45 seconds (${detail}).`
      : 'Hermes gateway did not become healthy within 45 seconds.';
    await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'error', lastError: message });
    return { error: message };
  }
  await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'running', lastError: null });
  return { port: ready.port };
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
  const deploymentId = agent.runtime.sandbox.deploymentId;
  dashboardReadyCache().delete(deploymentId);
  try {
    await stopProcess(deploymentId);
    await stopDockerSandboxContainer(agent.runtime.sandboxId);
    await updateRuntimeState(workspaceId, agent.runtime.id, { status: 'stopped', lastError: null });
  } catch (error) {
    const message = `Could not stop the Hermes runtime: ${copyErrorMessage(error)}`.slice(0, 4000);
    await Promise.all([
      updateRuntimeState(workspaceId, agent.runtime.id, { status: 'error', lastError: message })
        .catch(() => undefined),
      db.deployment.updateMany({
        where: { id: deploymentId, workspaceId, source: 'sandbox' },
        data: { status: 'error' },
      }).catch(() => undefined),
    ]);
    throw new Error(message, { cause: error });
  }
}

export async function cleanupHermesRuntime(
  workspaceId: string,
  agentId: string,
  options: { timeoutMs?: number } = {},
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
      { timeoutMs: options.timeoutMs ?? HERMES_ARCHIVE_IMPORT_TIMEOUT_MS },
    );
    return true;
  });
}
