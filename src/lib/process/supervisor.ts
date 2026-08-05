import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { type SpawnSpec } from './spawn-spec';
import { MCP_NETWORK } from './sandbox';
import { ensureConnectorBroker } from '@/lib/sandboxes/connector-broker';
import { deriveHermesRuntimeToken } from '@/lib/agents/hermes/token';

type Entry = {
  child: ChildProcess;
  port: number | null;
  status: string;
  pid?: number;
  name: string;
  stopping?: boolean;
  stopGraceMs?: number;
};

type Store = Map<string, Entry>;

type RegistryEntry = {
  deploymentId: string;
  name: string;
  pid: number;
  port: number | null;
  status: string;
  updatedAt: string;
};

// Persist the process table on globalThis so it survives dev hot-reload
// (module re-evaluation) while the Next server process stays alive.
const g = globalThis as unknown as {
  __mcpSupervisor?: Store;
  __mcpSupervisorPersistQueues?: Map<string, Promise<void>>;
  __mcpSupervisorLifecycleQueues?: Map<string, Promise<void>>;
  __mcpSupervisorTombstones?: Set<string>;
  __mcpSupervisorWorkspaceTombstones?: Set<string>;
};
function store(): Store {
  if (!g.__mcpSupervisor) g.__mcpSupervisor = new Map();
  return g.__mcpSupervisor;
}

function persistQueues(): Map<string, Promise<void>> {
  if (!g.__mcpSupervisorPersistQueues) g.__mcpSupervisorPersistQueues = new Map();
  return g.__mcpSupervisorPersistQueues;
}

function lifecycleQueues(): Map<string, Promise<void>> {
  if (!g.__mcpSupervisorLifecycleQueues) g.__mcpSupervisorLifecycleQueues = new Map();
  return g.__mcpSupervisorLifecycleQueues;
}

function tombstones(): Set<string> {
  if (!g.__mcpSupervisorTombstones) g.__mcpSupervisorTombstones = new Set();
  return g.__mcpSupervisorTombstones;
}

function workspaceTombstones(): Set<string> {
  if (!g.__mcpSupervisorWorkspaceTombstones) {
    g.__mcpSupervisorWorkspaceTombstones = new Set();
  }
  return g.__mcpSupervisorWorkspaceTombstones;
}

export function preventWorkspaceStarts(workspaceId: string): void {
  workspaceTombstones().add(workspaceId);
}

export function allowProcessRestart(deploymentId: string): void {
  tombstones().delete(deploymentId);
}

function launchPrevented(deploymentId: string, workspaceId?: string): boolean {
  return tombstones().has(deploymentId)
    || (workspaceId !== undefined && workspaceTombstones().has(workspaceId));
}

function enqueueLifecycle<T>(deploymentId: string, operation: () => Promise<T>): Promise<T> {
  const queues = lifecycleQueues();
  const previous = queues.get(deploymentId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(deploymentId, tail);
  return result.finally(() => {
    if (queues.get(deploymentId) === tail) {
      queues.delete(deploymentId);
    }
  });
}

const BUILTIN = path.join(process.cwd(), 'scripts', 'mcp-server.mjs');
const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
const SANDBOX_SERVER = path.join(process.cwd(), 'scripts', 'sandbox-mcp-server.mjs');
const REGISTRY_DIR = process.env.TOOLPLANE_SUPERVISOR_DIR || path.join(os.tmpdir(), 'toolplane-supervisor');

// How long startProcess waits for the child to print `LISTENING <port>` before
// returning. A builtin server is ready in ~50ms; a custom MCP cold-start (npx
// fetch / uvx / docker pull) measured ~5s, so 3s was too short — it returned
// while still "provisioning". 15s covers a cold start; the process still flips
// to running in the background if it exceeds even this.
const READY_TIMEOUT_MS = 90000;
const STOP_GRACE_MS = 5000;
const KILL_GRACE_MS = 1000;
const RUNTIME_LOG_MAX_BYTES = 512 * 1024;
const DOCKER_LOG_TIMEOUT_MS = 5000;

async function persist(deploymentId: string, status: string) {
  const queues = persistQueues();
  const previous = queues.get(deploymentId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    try {
      await db.deployment.update({ where: { id: deploymentId }, data: { status } });
    } catch {
      // deployment may have been removed; ignore
    }
  });
  queues.set(deploymentId, write);
  await write;
  if (queues.get(deploymentId) === write) {
    queues.delete(deploymentId);
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function deploymentContainerName(deploymentId: string): string {
  return `toolplane-mcp-${safeId(deploymentId)}`;
}

export function sandboxContainerName(sandboxId: string): string {
  return `toolplane-sandbox-${safeId(sandboxId)}`;
}

function registryPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.json`);
}

function runtimeLogPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.log`);
}

function ensureRegistryDir() {
  mkdirSync(REGISTRY_DIR, { recursive: true });
}

function appendRuntimeLog(deploymentId: string, stream: 'stdout' | 'stderr', value: string): void {
  if (!value) return;
  try {
    ensureRegistryDir();
    const prefix = `[${new Date().toISOString()}] [${stream}] `;
    const content = value
      .split(/(?<=\n)/)
      .map((line) => (line ? `${prefix}${line}` : line))
      .join('');
    const previous = existsSync(runtimeLogPath(deploymentId))
      ? readFileSync(runtimeLogPath(deploymentId))
      : Buffer.alloc(0);
    const next = Buffer.concat([previous, Buffer.from(content)]);
    const kept = next.byteLength > RUNTIME_LOG_MAX_BYTES
      ? Buffer.concat([
          Buffer.from('[runtime log truncated; showing the newest entries]\n'),
          next.subarray(next.byteLength - RUNTIME_LOG_MAX_BYTES),
        ])
      : next;
    writeFileSync(runtimeLogPath(deploymentId), kept, { mode: 0o600 });
  } catch {
    // Runtime logging must never affect the deployment lifecycle.
  }
}

function readRuntimeLog(deploymentId: string): string {
  try {
    return existsSync(runtimeLogPath(deploymentId))
      ? readFileSync(runtimeLogPath(deploymentId), 'utf8')
      : '';
  } catch {
    return '';
  }
}

function dockerCliEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

type DockerLogsResult = { code: number | null; text: string; error: string | null };

function readDockerLogs(containerName: string, limit: number): Promise<DockerLogsResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(
      'docker',
      ['logs', '--timestamps', '--tail', String(limit), containerName],
      { env: dockerCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, text: stdout, error: error || stderr.trim() || null });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch { /* process may have exited */ }
      finish(null, 'docker logs timed out');
    }, DOCKER_LOG_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(null, error.message));
    child.once('close', (code) => finish(code, code === 0 ? null : null));
  });
}

export type DeploymentContainerLogs = {
  containerName: string;
  text: string;
  source: 'docker' | 'captured' | 'none';
  error: string | null;
};

export async function getDeploymentContainerLogs(
  deploymentId: string,
  options: { containerName?: string; limit?: number } = {},
): Promise<DeploymentContainerLogs> {
  const containerName = options.containerName || deploymentContainerName(deploymentId);
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 500)));
  const docker = await readDockerLogs(containerName, limit);
  if (docker.code === 0) {
    return { containerName, text: docker.text, source: 'docker', error: null };
  }

  const captured = readRuntimeLog(deploymentId);
  return {
    containerName,
    text: captured,
    source: captured ? 'captured' : 'none',
    error: docker.error,
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function childTerminated(child: ChildProcess): boolean {
  return child.exitCode !== null
    || child.signalCode !== null
    || (child.pid === undefined ? true : !pidAlive(child.pid));
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childTerminated(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => {
      if (childTerminated(child)) finish(true);
    };
    const timer = setTimeout(() => finish(childTerminated(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (childTerminated(child)) finish(true);
  });
}

async function terminateChild(entry: Entry, force: boolean): Promise<void> {
  entry.stopping = true;
  entry.status = 'stopped';
  if (childTerminated(entry.child)) return;

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    entry.child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
  const graceMs = force ? KILL_GRACE_MS : (entry.stopGraceMs ?? STOP_GRACE_MS);
  if (await waitForChildExit(entry.child, graceMs)) return;

  try {
    entry.child.kill('SIGKILL');
  } catch {
    // Re-check through the exit waiter below.
  }
  if (await waitForChildExit(entry.child, KILL_GRACE_MS)) return;
  throw new Error(`Process ${entry.pid ?? 'unknown'} did not terminate.`);
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!pidAlive(pid)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!pidAlive(pid)) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(poll, 50);
      }
    };
    setTimeout(poll, 50);
  });
}

async function terminateRegisteredProcess(pid: number, force: boolean): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (!pidAlive(pid)) return;
    throw error;
  }
  if (await waitForPidExit(pid, force ? KILL_GRACE_MS : STOP_GRACE_MS)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!pidAlive(pid)) return;
    throw error;
  }
  if (await waitForPidExit(pid, KILL_GRACE_MS)) return;
  throw new Error(`Registered process ${pid} did not terminate.`);
}

function readRegistry(deploymentId: string): RegistryEntry | null {
  const file = registryPath(deploymentId);
  if (!existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as RegistryEntry;
    if (entry.deploymentId !== deploymentId || !pidAlive(entry.pid)) {
      rmSync(file, { force: true });
      return null;
    }
    return entry;
  } catch {
    rmSync(file, { force: true });
    return null;
  }
}

function writeRegistry(entry: RegistryEntry) {
  ensureRegistryDir();
  writeFileSync(registryPath(entry.deploymentId), JSON.stringify(entry), { mode: 0o600 });
}

function deleteRegistry(deploymentId: string, pid?: number) {
  const current = readRegistry(deploymentId);
  if (pid && current && current.pid !== pid) return;
  rmSync(registryPath(deploymentId), { force: true });
}

function liveRegistry(deploymentId: string): RegistryEntry | null {
  const e = store().get(deploymentId);
  if (e && e.child.exitCode === null && !e.stopping && e.pid && pidAlive(e.pid)) {
    return {
      deploymentId,
      name: e.name,
      pid: e.pid,
      port: e.port,
      status: e.status,
      updatedAt: new Date().toISOString(),
    };
  }
  return readRegistry(deploymentId);
}

// Create the dedicated MCP sandbox network if it doesn't exist (idempotent).
// Called once on startup before reconciling. Tolerant: if docker isn't
// reachable, it resolves quietly — custom MCP spawns would then fail on their
// own with a visible error.
export function ensureSandboxNetwork(): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = spawn('docker', ['network', 'inspect', MCP_NETWORK], { stdio: 'ignore' });
    check.on('error', () => resolve());
    check.on('exit', (code) => {
      if (code === 0) return resolve();
      const create = spawn('docker', ['network', 'create', MCP_NETWORK], { stdio: 'ignore' });
      create.on('error', () => resolve());
      create.on('exit', () => resolve());
    });
  });
}

export function liveStatus(deploymentId: string): string | null {
  return liveRegistry(deploymentId)?.status ?? null;
}

// Active states require a live supervised process. When the process table has
// no entry for a deployment (e.g. after a dev-server restart cleared it), a DB
// 'running'/'provisioning' is stale — the real status is 'stopped'. Terminal DB
// states (stopped/error) are accurate as-is. Use this — not `liveStatus(id) ??
// dbStatus` — wherever a deployment's status is displayed.
const ACTIVE_STATES = new Set(['running', 'provisioning']);
export function effectiveStatus(deploymentId: string, dbStatus: string): string {
  const live = liveStatus(deploymentId);
  if (live) return live;
  return ACTIVE_STATES.has(dbStatus) ? 'stopped' : dbStatus;
}

export function effectiveStatuses(
  deployments: ReadonlyArray<{ id: string; status: string }>,
): Map<string, string> {
  const statuses = new Map<string, string>();
  const registryFiles = (() => {
    try {
      return new Set(readdirSync(REGISTRY_DIR));
    } catch {
      return new Set<string>();
    }
  })();
  const currentStore = store();

  for (const deployment of deployments) {
    const entry = currentStore.get(deployment.id);
    if (entry && entry.child.exitCode === null && !entry.stopping && entry.pid && pidAlive(entry.pid)) {
      statuses.set(deployment.id, entry.status);
      continue;
    }

    const filename = `${safeId(deployment.id)}.json`;
    const registered = registryFiles.has(filename) ? readRegistry(deployment.id) : null;
    statuses.set(
      deployment.id,
      registered?.status ?? (ACTIVE_STATES.has(deployment.status) ? 'stopped' : deployment.status),
    );
  }

  return statuses;
}

export function livePort(deploymentId: string): number | null {
  return liveRegistry(deploymentId)?.port ?? null;
}

type StartProcessOptions = {
  awaitReady?: boolean;
  workspaceId?: string;
};

type LaunchResult = {
  ready: Promise<void> | null;
};

async function launchProcess(
  deploymentId: string,
  spec: SpawnSpec,
  workspaceId?: string,
): Promise<LaunchResult> {
  if (launchPrevented(deploymentId, workspaceId)) return { ready: null };
  const s = store();
  const existing = s.get(deploymentId);
  if (existing && existing.child.exitCode === null && !existing.stopping) {
    return { ready: null };
  }
  const registered = readRegistry(deploymentId);
  if (registered && registered.status === 'running' && registered.port) {
    void persist(deploymentId, 'running');
    return { ready: null };
  }

  const managedSpec: SpawnSpec = spec.kind === 'bridge'
    && spec.command === 'docker'
    && spec.args[0] === 'run'
    ? {
        ...spec,
        args: ['run', '--name', deploymentContainerName(deploymentId), ...spec.args.slice(1)],
      }
    : spec;

  const connectorBroker = managedSpec.kind === 'sandbox' && managedSpec.sandboxKind === 'connector'
    ? await ensureConnectorBroker()
    : null;
  if (launchPrevented(deploymentId, workspaceId)) return { ready: null };
  const script = managedSpec.kind === 'bridge' ? BRIDGE : managedSpec.kind === 'sandbox' ? SANDBOX_SERVER : BUILTIN;
  // The bridge keeps the app env only so it inherits DOCKER_HOST; it scrubs that
  // down to an allowlist before spawning the docker CLI. The MCP's own env is
  // already baked into spec.args as `-e` flags, so it is NOT injected here.
  const env =
    managedSpec.kind === 'bridge'
      ? {
          ...process.env,
          MCP_PORT: '0',
          MCP_NAME: managedSpec.name,
          MCP_COMMAND: managedSpec.command,
          MCP_ARGS: JSON.stringify(managedSpec.args),
        }
      : managedSpec.kind === 'sandbox'
        ? {
            PATH: process.env.PATH ?? '',
            NODE_ENV: process.env.NODE_ENV ?? 'production',
            HOME: process.env.HOME ?? '',
            DOCKER_HOST: process.env.DOCKER_HOST ?? '',
            DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH ?? '',
            DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY ?? '',
            LANG: process.env.LANG ?? '',
            LC_ALL: process.env.LC_ALL ?? '',
            MCP_PORT: '0',
            MCP_NAME: managedSpec.name,
            SANDBOX_ID: managedSpec.sandboxId,
            SANDBOX_KIND: managedSpec.sandboxKind,
            SANDBOX_IMAGE: managedSpec.image ?? '',
            SANDBOX_VOLUME: managedSpec.volumeName ?? '',
            SANDBOX_NETWORK: managedSpec.network,
            SANDBOX_ENV_JSON: JSON.stringify(managedSpec.env ?? {}),
            SANDBOX_CONNECTOR_BROKER_URL: connectorBroker?.internalUrl ?? '',
            SANDBOX_CONNECTOR_BROKER_TOKEN: connectorBroker?.internalToken ?? '',
            SANDBOX_CONNECTOR_REMOTE_ROOT: managedSpec.connector?.remoteRoot ?? '',
            HERMES_RUNTIME_ID: managedSpec.runtimeId ?? '',
            HERMES_RUNTIME_API_KEY: managedSpec.runtimeId
              ? deriveHermesRuntimeToken(managedSpec.runtimeId, 'hermes-api')
              : '',
            HERMES_RUNTIME_MODEL_NAME: managedSpec.runtimeModelName ?? 'hermes-agent',
            TOOLPLANE_MAX_ATTACHMENT_BYTES: process.env.TOOLPLANE_MAX_ATTACHMENT_BYTES ?? '',
          }
        : { ...process.env, MCP_PORT: '0', MCP_NAME: managedSpec.name };

  const child = spawn(process.execPath, [script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry: Entry = {
    child,
    port: null,
    status: 'provisioning',
    pid: child.pid,
    name: managedSpec.name,
    stopGraceMs: managedSpec.kind === 'sandbox' && managedSpec.sandboxKind === 'hermes' ? 35_000 : undefined,
  };
  s.set(deploymentId, entry);
  if (child.pid) {
    writeRegistry({
      deploymentId,
      name: managedSpec.name,
      pid: child.pid,
      port: null,
      status: 'provisioning',
      updatedAt: new Date().toISOString(),
    });
  }
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (buf: Buffer) => {
      const m = /LISTENING (\d+)/.exec(buf.toString());
      if (m) {
        // A buffered readiness line can arrive after stopProcess has already
        // revoked this process. Never let it recreate a running registry or DB
        // status. Per-deployment persistence queues preserve the same ordering
        // when a previously-started running write is still in flight.
        if (entry.stopping || child.exitCode !== null || store().get(deploymentId) !== entry) {
          resolve();
          return;
        }
        entry.port = Number(m[1]);
        entry.status = 'running';
        if (child.pid) {
          writeRegistry({
            deploymentId,
            name: managedSpec.name,
            pid: child.pid,
            port: entry.port,
            status: 'running',
            updatedAt: new Date().toISOString(),
          });
        }
        void persist(deploymentId, 'running');
        resolve();
      }
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      appendRuntimeLog(deploymentId, 'stderr', text);
      console.error(`[mcp-supervisor:${deploymentId}] ${text.trimEnd()}`);
    });
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
    setTimeout(resolve, READY_TIMEOUT_MS);
  });

  child.on('exit', (code) => {
    entry.status = entry.stopping ? 'stopped' : code === 0 ? 'stopped' : 'error';
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    void persist(deploymentId, entry.status);
  });
  child.on('error', () => {
    entry.status = entry.stopping ? 'stopped' : 'error';
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    void persist(deploymentId, entry.status);
  });

  // Status persistence is ordered per deployment but deliberately does not
  // hold the lifecycle queue. A stop must be able to signal the local child
  // even while a slow database write is still in flight.
  void persist(deploymentId, 'provisioning');
  return { ready };
}

export async function startProcess(
  deploymentId: string,
  spec: SpawnSpec,
  options: StartProcessOptions = {},
): Promise<void> {
  const { ready } = await enqueueLifecycle(deploymentId, () => (
    launchProcess(deploymentId, spec, options.workspaceId)
  ));
  if ((options.awaitReady ?? true) && ready) await ready;
}

async function stopProcessUnlocked(
  deploymentId: string,
  force = false,
  finalStatus = 'stopped',
): Promise<void> {
  const e = store().get(deploymentId);
  const registered = readRegistry(deploymentId);
  try {
    if (e) await terminateChild(e, force);
    if (registered && registered.pid !== e?.pid) {
      await terminateRegisteredProcess(registered.pid, force);
    }
  } catch (error) {
    if (e) e.status = 'error';
    await persist(deploymentId, 'error');
    throw error;
  }
  deleteRegistry(deploymentId);
  if (e && store().get(deploymentId) === e) store().delete(deploymentId);
  await persist(deploymentId, finalStatus);
}

export async function stopProcess(deploymentId: string): Promise<void> {
  await enqueueLifecycle(deploymentId, () => stopProcessUnlocked(deploymentId));
}

export async function restartProcess(
  deploymentId: string,
  spec: SpawnSpec,
  options: StartProcessOptions = {},
): Promise<void> {
  const { ready } = await enqueueLifecycle(deploymentId, async () => {
    await stopProcessUnlocked(deploymentId);
    return launchProcess(deploymentId, spec, options.workspaceId);
  });
  if ((options.awaitReady ?? true) && ready) await ready;
}

export type KillProcessOptions = {
  preventRestart?: boolean;
  finalStatus?: string;
};

export async function killProcess(
  deploymentId: string,
  options: KillProcessOptions = {},
): Promise<void> {
  if (options.preventRestart) tombstones().add(deploymentId);
  await enqueueLifecycle(
    deploymentId,
    () => stopProcessUnlocked(deploymentId, true, options.finalStatus),
  );
}

// Kill every supervised process for a set of deployments (e.g. when a
// workspace is deleted) so no child processes are left orphaned.
export async function killMany(
  deploymentIds: string[],
  options: KillProcessOptions = {},
): Promise<void> {
  await Promise.all(deploymentIds.map((id) => killProcess(id, {
    ...options,
    preventRestart: true,
  })));
}
