import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { type SpawnSpec } from './spawn-spec';
import { MCP_NETWORK } from './sandbox';
import { ensureConnectorBroker } from '@/lib/sandboxes/connector-broker';
import { deriveHermesRuntimeToken } from '@/lib/agents/hermes/token';
import {
  DEPLOYMENT_CONFIG_MOUNT_PATH,
  configVolumeName,
  materializeDeploymentConfigVolume,
} from './deployment-config-volume';

type Entry = {
  child: ChildProcess;
  port: number | null;
  status: string;
  pid?: number;
  name: string;
  stopping?: boolean;
  stopGraceMs?: number;
  runtime: RuntimeRecord;
  redactionValues: string[];
  // A launch-private capability used only to authenticate lifecycle events
  // emitted by the bridge. It never enters the runtime record or log file.
  runtimeEventToken: string;
  // Hold incomplete stderr lines until they can be redacted as a whole. This
  // is important because a configured secret can arrive split across stream
  // chunks.
  stderrBuffer: string;
  stderrDecoder: StringDecoder;
  discardingOverlongStderrLine: boolean;
};

type Store = Map<string, Entry>;

type RegistryEntry = {
  deploymentId: string;
  name: string;
  pid: number;
  port: number | null;
  status: string;
  updatedAt: string;
  generation?: string;
  phase?: string;
  containerName?: string;
  containerState?: string;
  imageState?: string;
  startedAt?: string;
  lastActivityAt?: string;
  logStartCursor?: number;
  logEndCursor?: number;
};

export type DeploymentRuntimeSnapshot = {
  // Kept in the supervisor runtime registry instead of Prisma. The database
  // status remains the durable deployment status; phase is deliberately a
  // live, best-effort progress signal.
  status: string;
  phase: string;
  generation: string;
  containerName?: string;
  containerState?: string;
  imageState?: string;
  startedAt?: string;
  lastActivityAt?: string;
  updatedAt?: string;
};

export type DeploymentRuntimeLogChunk = {
  generation: string | null;
  // The cursor used for this chunk and the cursor to send on the next request.
  // Both are byte offsets rather than JS string offsets.
  cursor: number;
  nextCursor: number;
  // True when a caller's cursor belongs to another launch generation, or the
  // requested data has fallen out of the bounded local log buffer.
  reset: boolean;
  text: string;
  truncated?: boolean;
};

type RuntimeRecord = DeploymentRuntimeSnapshot & {
  deploymentId: string;
  pid?: number;
  logStartCursor: number;
  logEndCursor: number;
};

// Persist the process table on globalThis so it survives dev hot-reload
// (module re-evaluation) while the Next server process stays alive.
const g = globalThis as unknown as {
  __mcpSupervisor?: Store;
  __mcpSupervisorPersistQueues?: Map<string, Promise<void>>;
  __mcpSupervisorLifecycleQueues?: Map<string, Promise<void>>;
  __mcpSupervisorTombstones?: Set<string>;
  __mcpSupervisorWorkspaceTombstones?: Set<string>;
  __mcpSupervisorRuntime?: Map<string, RuntimeRecord>;
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

function runtimeStore(): Map<string, RuntimeRecord> {
  if (!g.__mcpSupervisorRuntime) g.__mcpSupervisorRuntime = new Map();
  return g.__mcpSupervisorRuntime;
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

// The bridge uses progress-aware idle and overall budgets. This supervisor
// timeout only bounds callers that explicitly await readiness; it never marks
// a deployment failed and therefore must not be used as an initialize timeout.
const READY_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 5000;
const KILL_GRACE_MS = 1000;
const RUNTIME_LOG_MAX_BYTES = 512 * 1024;
const RUNTIME_LOG_CHUNK_MAX_BYTES = 64 * 1024;
const RUNTIME_LOG_CHUNK_DEFAULT_BYTES = 16 * 1024;
const STDERR_LINE_BUFFER_MAX_CHARS = 256 * 1024;
const DOCKER_LOG_TIMEOUT_MS = 5000;
const LAUNCH_LOCK_MAX_AGE_MS = 10 * 60_000;
const STARTUP_IDLE_TIMEOUT_MS = runtimeTimeoutFromEnv(
  process.env.TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS ?? process.env.MCP_STARTUP_IDLE_TIMEOUT_MS,
  90_000,
);
const STARTUP_MAX_TIMEOUT_MS = runtimeTimeoutFromEnv(
  process.env.TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS ?? process.env.MCP_STARTUP_MAX_TIMEOUT_MS,
  5 * 60_000,
);

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

function runtimePath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.runtime.json`);
}

function runtimeLogPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.log`);
}

function launchLockPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.launch.lock`);
}

function ensureRegistryDir() {
  mkdirSync(REGISTRY_DIR, { recursive: true });
}

function runtimeTimeoutFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) return fallback;
  // A malformed environment value must not accidentally pin an orphaned
  // deployment forever. Thirty minutes remains ample for a slow image pull.
  return Math.min(Math.floor(parsed), 30 * 60_000);
}

function writeAtomic(file: string, content: string | Buffer): void {
  ensureRegistryDir();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    // `renameSync` either moved this file or failed. Best-effort cleanup avoids
    // leaving a secret-bearing temp file after a full disk or permission error.
    rmSync(temp, { force: true });
  }
}

type LaunchLockRecord = {
  pid?: number;
  createdAt?: string;
  nonce?: string;
};

function launchLockIsStale(file: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as LaunchLockRecord;
    const createdAt = typeof lock.createdAt === 'string' ? Date.parse(lock.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > LAUNCH_LOCK_MAX_AGE_MS) return true;
    if (typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0) {
      return !pidAlive(lock.pid);
    }
    return true;
  } catch {
    // Do not race an owner while it is writing the small lock payload. An
    // unreadable lock is eligible for recovery only after its filesystem age
    // exceeds the normal maximum startup duration.
    try {
      return Date.now() - statSync(file).mtimeMs > LAUNCH_LOCK_MAX_AGE_MS;
    } catch {
      return false;
    }
  }
}

function acquireLaunchLock(deploymentId: string): (() => void) | null {
  const file = launchLockPath(deploymentId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ensureRegistryDir();
    const nonce = randomUUID();
    let descriptor: number | undefined;
    let ownsLock = false;
    try {
      descriptor = openSync(file, 'wx', 0o600);
      ownsLock = true;
      writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        nonce,
      }));
      closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = JSON.parse(readFileSync(file, 'utf8')) as LaunchLockRecord;
          if (current.nonce === nonce) rmSync(file, { force: true });
        } catch {
          // A replacement lock (or already-cleaned lock) is not ours to remove.
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* best effort */ }
      }
      if (ownsLock) {
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
        return null;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !launchLockIsStale(file)) {
        return null;
      }
      try {
        rmSync(file, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

function asOptionalRuntimeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function runtimeRecordFromUnknown(value: unknown, deploymentId: string): RuntimeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.deploymentId !== deploymentId) return null;
  const status = asOptionalRuntimeString(input.status);
  const phase = asOptionalRuntimeString(input.phase);
  const generation = asOptionalRuntimeString(input.generation);
  if (!status || !phase || !generation) return null;
  const numberOr = (field: string, fallback: number) => {
    const candidate = input[field];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : fallback;
  };
  const logStartCursor = numberOr('logStartCursor', 0);
  const logEndCursor = Math.max(logStartCursor, numberOr('logEndCursor', logStartCursor));
  const pid = numberOr('pid', 0);
  return {
    deploymentId,
    status,
    phase,
    generation,
    ...(pid > 0 ? { pid } : {}),
    ...(asOptionalRuntimeString(input.containerName) ? { containerName: asOptionalRuntimeString(input.containerName) } : {}),
    ...(asOptionalRuntimeString(input.containerState) ? { containerState: asOptionalRuntimeString(input.containerState) } : {}),
    ...(asOptionalRuntimeString(input.imageState) ? { imageState: asOptionalRuntimeString(input.imageState) } : {}),
    ...(asOptionalRuntimeString(input.startedAt) ? { startedAt: asOptionalRuntimeString(input.startedAt) } : {}),
    ...(asOptionalRuntimeString(input.lastActivityAt) ? { lastActivityAt: asOptionalRuntimeString(input.lastActivityAt) } : {}),
    ...(asOptionalRuntimeString(input.updatedAt) ? { updatedAt: asOptionalRuntimeString(input.updatedAt) } : {}),
    logStartCursor,
    logEndCursor,
  };
}

function writeRuntimeRecord(record: RuntimeRecord): void {
  runtimeStore().set(record.deploymentId, record);
  try {
    writeAtomic(runtimePath(record.deploymentId), JSON.stringify(record));
  } catch {
    // Runtime progress must never affect the deployment lifecycle. The in-memory
    // record is still useful to the current worker if disk persistence fails.
  }
}

function readRuntimeRecord(
  deploymentId: string,
  options: { fresh?: boolean } = {},
): RuntimeRecord | null {
  const inMemory = runtimeStore().get(deploymentId);
  if (inMemory && !options.fresh) return inMemory;
  try {
    if (!existsSync(runtimePath(deploymentId))) return null;
    const parsed = runtimeRecordFromUnknown(
      JSON.parse(readFileSync(runtimePath(deploymentId), 'utf8')),
      deploymentId,
    );
    if (parsed) runtimeStore().set(deploymentId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function snapshotFromRuntime(record: RuntimeRecord): DeploymentRuntimeSnapshot {
  return {
    status: record.status,
    phase: record.phase,
    generation: record.generation,
    ...(record.containerName ? { containerName: record.containerName } : {}),
    ...(record.containerState ? { containerState: record.containerState } : {}),
    ...(record.imageState ? { imageState: record.imageState } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  };
}

function touchRuntime(record: RuntimeRecord, activity = false): void {
  const now = new Date().toISOString();
  if (activity) record.lastActivityAt = now;
  record.updatedAt = now;
}

function runtimeFields(record: RuntimeRecord): Pick<RegistryEntry,
  'generation' | 'phase' | 'containerName' | 'containerState' | 'imageState' | 'startedAt' | 'lastActivityAt' | 'logStartCursor' | 'logEndCursor'
> {
  return {
    generation: record.generation,
    phase: record.phase,
    ...(record.containerName ? { containerName: record.containerName } : {}),
    ...(record.containerState ? { containerState: record.containerState } : {}),
    ...(record.imageState ? { imageState: record.imageState } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
    logStartCursor: record.logStartCursor,
    logEndCursor: record.logEndCursor,
  };
}

function syncRuntimeRegistry(entry: Entry): void {
  if (!entry.pid || childTerminated(entry.child)) return;
  writeRegistry({
    deploymentId: entry.runtime.deploymentId,
    name: entry.name,
    pid: entry.pid,
    port: entry.port,
    status: entry.status,
    updatedAt: new Date().toISOString(),
    ...runtimeFields(entry.runtime),
  });
}

function updateRuntime(entry: Entry, update: Partial<Pick<RuntimeRecord,
  'status' | 'phase' | 'containerName' | 'containerState' | 'imageState'
>>, activity = false): void {
  Object.assign(entry.runtime, update);
  touchRuntime(entry.runtime, activity);
  writeRuntimeRecord(entry.runtime);
  syncRuntimeRegistry(entry);
}

function updateDetachedRuntime(
  deploymentId: string,
  update: Partial<Pick<RuntimeRecord, 'status' | 'phase'>>,
  activity = false,
): void {
  const runtime = readRuntimeRecord(deploymentId, { fresh: true });
  if (!runtime) return;
  Object.assign(runtime, update);
  touchRuntime(runtime, activity);
  writeRuntimeRecord(runtime);
}

function resetRuntimeLog(deploymentId: string): void {
  try {
    ensureRegistryDir();
    writeFileSync(runtimeLogPath(deploymentId), '', { mode: 0o600 });
  } catch {
    // The process can still start when local log storage is temporarily bad.
  }
}

function secretValuesFromEnv(env: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const value of Object.values(env)) {
    // Configured MCP env is intentionally treated as confidential by default.
    // Short primitives cannot meaningfully reveal a credential and redacting
    // them would make normal logs unreadable (e.g. PORT=3).
    if (typeof value === 'string' && value.length >= 3) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function sensitiveArgValues(args: readonly string[]): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 3 && value.length <= 16 * 1024) values.add(value);
  };
  const isSensitiveName = (name: string) => /(?:api[_-]?key|token|secret|pass(?:word)?|credential|authorization|cookie|private[_-]?key|client[_-]?secret)/i.test(name);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = /^--?([^=]+)=(.*)$/.exec(arg);
    if (equals && isSensitiveName(equals[1])) add(equals[2]);
    if (/^--?(?:api[_-]?key|token|secret|pass(?:word)?|credential|authorization|cookie|private[_-]?key|client[_-]?secret)$/i.test(arg)) {
      add(args[index + 1]);
      index += 1;
      continue;
    }
    // A manually-specified `docker -e KEY=value` can bypass installCfg.env.
    // Treat every explicit env value as confidential, matching the policy for
    // the structured env object above.
    if (arg === '-e' || arg === '--env') {
      const pair = args[index + 1];
      const separator = pair?.indexOf('=') ?? -1;
      if (separator >= 0) add(pair.slice(separator + 1));
      index += 1;
    }

    // Credential-bearing URLs are common in SSH and Git MCP configs. Capture
    // only their userinfo components as redaction values; never retain the argv
    // itself in the runtime registry or log.
    for (const match of arg.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/)?([^:/@\s]+):([^@/\s]+)@/gi)) {
      add(match[2]);
    }
    for (const match of arg.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^:/@\s]+)@/gi)) {
      add(match[1]);
    }
    try {
      const url = new URL(arg);
      for (const [name, value] of url.searchParams) {
        if (isSensitiveName(name)) add(value);
      }
    } catch {
      // Most command arguments are not URLs.
    }
  }
  return [...values];
}

function redactionValuesForSpec(spec: SpawnSpec): string[] {
  const values = new Set(secretValuesFromEnv(spec.kind === 'builtin' ? {} : spec.env));
  if (spec.kind === 'bridge') {
    for (const value of sensitiveArgValues(spec.args)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactRuntimeLog(value: string, secretValues: string[]): string {
  let redacted = value;
  for (const secret of secretValues) {
    redacted = redacted.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) redacted = redacted.split(escaped).join('[REDACTED]');
  }
  // Key/value, JSON, URLs and common token prefixes cover output that echoes a
  // secret without it being present in the deployment's configured env.
  redacted = redacted
    .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|credential|cookie|private[_-]?key|client[_-]?secret)\s*[=:]\s*)(["']?)[^\s,;&"']+/gi, '$1$2[REDACTED]')
    .replace(/("(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|client[_-]?secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]');
  return redacted;
}

function appendRuntimeLog(entry: Entry, value: string): string {
  if (!value) return '';
  const redacted = redactRuntimeLog(value, entry.redactionValues);
  const prefix = `[${new Date().toISOString()}] [stderr] `;
  const content = redacted
    .split(/(?<=\n)/)
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('');
  const appended = Buffer.from(content);
  try {
    ensureRegistryDir();
    const previous = existsSync(runtimeLogPath(entry.runtime.deploymentId))
      ? readFileSync(runtimeLogPath(entry.runtime.deploymentId))
      : Buffer.alloc(0);
    const next = Buffer.concat([previous, appended]);
    const kept = next.byteLength > RUNTIME_LOG_MAX_BYTES
      ? next.subarray(next.byteLength - RUNTIME_LOG_MAX_BYTES)
      : next;
    writeFileSync(runtimeLogPath(entry.runtime.deploymentId), kept, { mode: 0o600 });
    entry.runtime.logEndCursor += appended.byteLength;
    entry.runtime.logStartCursor = entry.runtime.logEndCursor - kept.byteLength;
  } catch {
    // Keep an in-memory cursor even if the best-effort log write failed.
    entry.runtime.logEndCursor += appended.byteLength;
    entry.runtime.logStartCursor = entry.runtime.logEndCursor;
  }
  updateRuntime(entry, {}, true);
  return redacted;
}

function recordRuntimeStderr(entry: Entry, value: string): void {
  const redacted = appendRuntimeLog(entry, value);
  if (redacted) console.error(`[mcp-supervisor:${entry.runtime.deploymentId}] ${redacted.trimEnd()}`);
}

function completeStderrLines(value: string, terminal: boolean): { lines: string[]; tail: string } {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\n' && char !== '\r') continue;
    let end = index + 1;
    if (char === '\r' && value[index + 1] === '\n') {
      end += 1;
      index += 1;
    }
    lines.push(value.slice(start, end));
    start = end;
  }
  const tail = value.slice(start);
  if (terminal && tail) {
    lines.push(tail);
    return { lines, tail: '' };
  }
  return { lines, tail };
}

function formatBridgeRuntimeEvent(event: BridgeRuntimeEvent): string {
  const field = (value: unknown) => typeof value === 'string'
    ? value.replace(/[\r\n]/g, ' ').slice(0, 512)
    : '';
  const details = [
    `phase=${field(event.phase) || 'unknown'}`,
    ...(field(event.imageState) ? [`image=${field(event.imageState)}`] : []),
    ...(field(event.containerState) ? [`container=${field(event.containerState)}`] : []),
  ];
  return `[toolplane-runtime] ${details.join(' ')}\n`;
}

function consumeBridgeRuntimeEvent(entry: Entry, line: string): boolean {
  const marker = line.indexOf(BRIDGE_RUNTIME_EVENT_PREFIX);
  if (marker < 0) return false;
  try {
    const event = JSON.parse(line.slice(marker + BRIDGE_RUNTIME_EVENT_PREFIX.length).trim()) as BridgeRuntimeEvent;
    // A containerized MCP can write arbitrary stderr. Only the bridge knows
    // the launch-private token, so an event without it must be treated as an
    // ordinary (redacted) diagnostic rather than trusted lifecycle metadata.
    if (event.type !== 'phase' || event.token !== entry.runtimeEventToken) return false;
    updateRuntimeFromBridgeEvent(entry, event);
    recordRuntimeStderr(entry, formatBridgeRuntimeEvent(event));
    return true;
  } catch {
    return false;
  }
}

function recordCompleteStderr(entry: Entry, value: string, terminal = false): void {
  const { lines, tail } = completeStderrLines(value, terminal);
  let ordinary = '';
  const flushOrdinary = () => {
    if (!ordinary) return;
    recordRuntimeStderr(entry, ordinary);
    ordinary = '';
  };
  for (const line of lines) {
    if (line.length > STDERR_LINE_BUFFER_MAX_CHARS) {
      flushOrdinary();
      recordRuntimeStderr(entry, '[toolplane-runtime] omitted overlong stderr line\n');
      continue;
    }
    if (consumeBridgeRuntimeEvent(entry, line)) {
      flushOrdinary();
    } else {
      ordinary += line;
    }
  }
  flushOrdinary();
  entry.stderrBuffer = tail;
}

function discardUntilLineBreak(entry: Entry, value: string): string {
  if (!entry.discardingOverlongStderrLine) return value;
  const index = value.search(/[\r\n]/);
  if (index < 0) return '';
  let next = index + 1;
  if (value[index] === '\r' && value[next] === '\n') next += 1;
  entry.discardingOverlongStderrLine = false;
  return value.slice(next);
}

function captureRuntimeStderr(entry: Entry, value: string): void {
  value = discardUntilLineBreak(entry, value);
  if (!value) return;
  entry.stderrBuffer += value;
  recordCompleteStderr(entry, entry.stderrBuffer);
  if (entry.stderrBuffer.length <= STDERR_LINE_BUFFER_MAX_CHARS) return;
  // Never emit a raw prefix from a line that has grown beyond the bounded
  // buffer. An unknown Authorization/token value might itself be split across
  // chunks, so a safe omission is preferable to a partially redacted leak.
  entry.stderrBuffer = '';
  entry.discardingOverlongStderrLine = true;
  recordRuntimeStderr(entry, '[toolplane-runtime] omitted overlong stderr line\n');
}

function flushRuntimeStderr(entry: Entry): void {
  if (!entry.stderrBuffer) return;
  recordCompleteStderr(entry, entry.stderrBuffer, true);
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

function registryGeneration(entry: RegistryEntry): string {
  // Pre-runtime-registry deployments can still have a live bridge after an app
  // upgrade. A pid-scoped synthetic generation is stable for that process and
  // lets polling clients reset cleanly when it is eventually replaced.
  return entry.generation ?? `legacy-${entry.pid}`;
}

function registryDiffersFromRuntime(entry: RegistryEntry, runtime: RuntimeRecord): boolean {
  return entry.pid !== runtime.pid
    || (entry.generation !== undefined && entry.generation !== runtime.generation);
}

function snapshotFromRegistry(entry: RegistryEntry): DeploymentRuntimeSnapshot {
  return {
    status: entry.status,
    phase: entry.phase ?? (entry.status === 'running' ? 'ready' : 'initializing'),
    generation: registryGeneration(entry),
    ...(entry.containerName ? { containerName: entry.containerName } : {}),
    ...(entry.containerState ? { containerState: entry.containerState } : {}),
    ...(entry.imageState ? { imageState: entry.imageState } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.lastActivityAt ? { lastActivityAt: entry.lastActivityAt } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

export function getDeploymentRuntimeSnapshot(deploymentId: string): DeploymentRuntimeSnapshot | null {
  const local = localLiveEntry(deploymentId);
  // A process can be owned by another Next worker. In that case never serve a
  // permanently cached runtime record: its worker may already have restarted
  // the deployment and replaced both generation and log file.
  const runtime = local?.runtime ?? readRuntimeRecord(deploymentId, { fresh: true });
  const registry = readRegistry(deploymentId);
  if (registry && (!runtime || registryDiffersFromRuntime(registry, runtime))) {
    return snapshotFromRegistry(registry);
  }
  if (!runtime) {
    const live = local ? registryFromLocalEntry(local) : null;
    return live ? snapshotFromRegistry(live) : null;
  }

  // Runtime metadata intentionally survives terminal failures so the UI can
  // read the last stderr generation. Do not, however, let a stale active
  // snapshot resurrect a process after the Next worker (or its child) died.
  if (runtime.status === 'running' || runtime.status === 'provisioning') {
    const live = registry ?? (local ? registryFromLocalEntry(local) : null);
    if (!live || (runtime.pid !== undefined && runtime.pid !== live.pid)) {
      return {
        ...snapshotFromRuntime(runtime),
        status: 'stopped',
        phase: 'stopped',
      };
    }
  }
  return snapshotFromRuntime(runtime);
}

function boundedLogLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return RUNTIME_LOG_CHUNK_DEFAULT_BYTES;
  return Math.max(1, Math.min(RUNTIME_LOG_CHUNK_MAX_BYTES, Math.floor(value as number)));
}

export function getDeploymentRuntimeLogChunk(
  deploymentId: string,
  options: { generation?: string; cursor?: number; limit?: number } = {},
): DeploymentRuntimeLogChunk {
  const local = localLiveEntry(deploymentId);
  const runtime = local?.runtime ?? readRuntimeRecord(deploymentId, { fresh: true });
  const registry = readRegistry(deploymentId);
  const registryWins = registry !== null && (!runtime || registryDiffersFromRuntime(registry, runtime));
  const generation = registryWins
    ? registryGeneration(registry)
    : runtime?.generation ?? (registry ? registryGeneration(registry) : null);
  const log = (() => {
    try {
      return existsSync(runtimeLogPath(deploymentId))
        ? readFileSync(runtimeLogPath(deploymentId))
        : Buffer.alloc(0);
    } catch {
      return Buffer.alloc(0);
    }
  })();
  const registryLogEnd = registryWins && typeof registry.logEndCursor === 'number'
    ? registry.logEndCursor
    : undefined;
  const registryLogStart = registryWins && typeof registry.logStartCursor === 'number'
    ? registry.logStartCursor
    : undefined;
  const logEndCursor = registryLogEnd ?? runtime?.logEndCursor ?? log.byteLength;
  const logStartCursor = registryLogStart !== undefined
    ? Math.max(0, Math.min(registryLogStart, logEndCursor))
    : runtime
    ? Math.max(0, Math.min(runtime.logStartCursor, logEndCursor))
    : Math.max(0, logEndCursor - log.byteLength);
  const requestedCursor = typeof options.cursor === 'number' && Number.isFinite(options.cursor)
    ? Math.max(0, Math.floor(options.cursor))
    : 0;
  let reset = options.generation !== undefined && options.generation !== generation;
  let cursor = reset ? logStartCursor : requestedCursor;
  if (cursor < logStartCursor || cursor > logEndCursor) {
    reset = true;
    cursor = logStartCursor;
  }
  const start = Math.max(0, Math.min(log.byteLength, cursor - logStartCursor));
  const limit = boundedLogLimit(options.limit);
  const slice = log.subarray(start, Math.min(log.byteLength, start + limit));
  const nextCursor = cursor + slice.byteLength;
  return {
    generation,
    cursor,
    nextCursor,
    reset,
    text: slice.toString('utf8'),
    ...(cursor > logStartCursor ? {} : logStartCursor > 0 ? { truncated: true } : {}),
  };
}

type BridgeRuntimeEvent = {
  type?: string;
  token?: string;
  phase?: string;
  containerState?: string;
  imageState?: string;
};

const BRIDGE_RUNTIME_EVENT_PREFIX = '[toolplane-runtime] ';

function initialRuntimeRecord(deploymentId: string, spec: SpawnSpec, pid?: number): RuntimeRecord {
  const now = new Date().toISOString();
  const containerName = spec.kind === 'bridge' && spec.command === 'docker'
    ? deploymentContainerName(deploymentId)
    : spec.kind === 'sandbox' && spec.sandboxKind === 'docker' && spec.sandboxId
      ? sandboxContainerName(spec.sandboxId)
      : undefined;
  return {
    deploymentId,
    status: 'provisioning',
    phase: spec.kind === 'bridge' ? 'preparing-image' : 'initializing',
    generation: randomUUID(),
    ...(pid ? { pid } : {}),
    ...(containerName ? { containerName } : {}),
    startedAt: now,
    lastActivityAt: now,
    updatedAt: now,
    logStartCursor: 0,
    logEndCursor: 0,
  };
}

function updateRuntimeFromBridgeEvent(entry: Entry, event: BridgeRuntimeEvent): void {
  if (event.type !== 'phase') return;
  const phase = asOptionalRuntimeString(event.phase);
  const containerState = asOptionalRuntimeString(event.containerState);
  const imageState = asOptionalRuntimeString(event.imageState);
  if (!phase && !containerState && !imageState) return;
  updateRuntime(entry, {
    ...(phase ? { phase } : {}),
    ...(containerState ? { containerState } : {}),
    ...(imageState ? { imageState } : {}),
  }, true);
}

function bridgeImage(spec: Extract<SpawnSpec, { kind: 'bridge' }>): string {
  if (spec.image) return spec.image;
  if (spec.command !== 'docker' || spec.args[0] !== 'run') return '';

  // Most callers receive `image` from buildSpawnSpec. Keep a small, private
  // fallback for older callers that destructure only command/args (such as the
  // recipe validator). It is used solely for bridge readiness checks and is
  // never recorded in supervisor logs.
  const optionsWithValue = new Set([
    '--name', '--cap-drop', '--security-opt', '--tmpfs', '--pids-limit',
    '--memory', '--cpus', '--network', '--pull', '--env', '--env-file', '-e',
    '--mount', '--workdir',
  ]);
  for (let index = 1; index < spec.args.length; index += 1) {
    const value = spec.args[index];
    if (value === '--') return spec.args[index + 1] ?? '';
    if (optionsWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    return value;
  }
  return '';
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
    // A second worker may be replacing this registry at this exact moment.
    // Do not remove an unreadable file here: writeRegistry uses atomic rename
    // now, and keeping a legacy half-written file is safer than deleting a
    // live worker's ownership signal.
    return null;
  }
}

function writeRegistry(entry: RegistryEntry) {
  writeAtomic(registryPath(entry.deploymentId), JSON.stringify(entry));
}

function deleteRegistry(deploymentId: string, pid?: number) {
  const current = readRegistry(deploymentId);
  if (pid && current && current.pid !== pid) return;
  rmSync(registryPath(deploymentId), { force: true });
}

function localLiveEntry(deploymentId: string): Entry | null {
  const entry = store().get(deploymentId);
  if (!entry || entry.stopping || !entry.pid || childTerminated(entry.child)) return null;
  return entry;
}

function registryFromLocalEntry(entry: Entry): RegistryEntry {
  return {
    deploymentId: entry.runtime.deploymentId,
    name: entry.name,
    pid: entry.pid!,
    port: entry.port,
    status: entry.status,
    updatedAt: new Date().toISOString(),
    ...runtimeFields(entry.runtime),
  };
}

function liveRegistry(deploymentId: string): RegistryEntry | null {
  const local = localLiveEntry(deploymentId);
  const persisted = readRegistry(deploymentId);
  // A different live PID (or a new generation from another worker) owns the
  // deployment now. Prefer the cross-worker registry over a stale local map.
  if (persisted && (!local || registryDiffersFromRuntime(persisted, local.runtime))) {
    return persisted;
  }
  return local ? registryFromLocalEntry(local) : persisted;
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
  for (const deployment of deployments) {
    const local = localLiveEntry(deployment.id);
    const filename = `${safeId(deployment.id)}.json`;
    const registered = registryFiles.has(filename) ? readRegistry(deployment.id) : null;
    if (registered && (!local || registryDiffersFromRuntime(registered, local.runtime))) {
      statuses.set(deployment.id, registered.status);
      continue;
    }
    if (local) {
      statuses.set(deployment.id, local.status);
      continue;
    }
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

function withDeploymentConfigVolume(
  spec: Extract<SpawnSpec, { kind: 'bridge' }>,
  deploymentId: string,
): Extract<SpawnSpec, { kind: 'bridge' }> {
  if (spec.command !== 'docker' || spec.args[0] !== 'run') {
    throw new Error('Runtime files require a Docker-backed MCP deployment.');
  }
  return {
    ...spec,
    args: [
      'run',
      '--mount',
      `type=volume,src=${configVolumeName(deploymentId)},dst=${DEPLOYMENT_CONFIG_MOUNT_PATH},readonly`,
      ...(spec.configWorkingDirectory ? ['--workdir', DEPLOYMENT_CONFIG_MOUNT_PATH] : []),
      ...spec.args.slice(1),
    ],
  };
}

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
  if (registered && (registered.status === 'running' || registered.status === 'provisioning')) {
    // Another worker is already responsible for this child. Cross-worker
    // readiness promises are not shareable, so return immediately and let the
    // runtime snapshot polling surface its phase instead of spawning a second
    // container that races for the same deployment identity.
    void persist(deploymentId, registered.status);
    return { ready: null };
  }

  const connectorBroker = spec.kind === 'sandbox' && spec.sandboxKind === 'connector'
    ? await ensureConnectorBroker()
    : null;
  if (launchPrevented(deploymentId, workspaceId)) return { ready: null };
  const releaseLaunchLock = acquireLaunchLock(deploymentId);
  if (!releaseLaunchLock) {
    // The owner may still be between spawn() and its atomic registry write.
    // Do not race it; surface provisioning until that worker publishes a
    // registry or reports its own failure.
    const owner = readRegistry(deploymentId);
    void persist(deploymentId, owner?.status === 'running' || owner?.status === 'provisioning'
      ? owner.status
      : 'provisioning');
    return { ready: null };
  }
  const releaseLockAndReturn = (result: LaunchResult): LaunchResult => {
    releaseLaunchLock();
    return result;
  };
  if (launchPrevented(deploymentId, workspaceId)) return releaseLockAndReturn({ ready: null });
  const existingAfterLock = s.get(deploymentId);
  if (existingAfterLock && existingAfterLock.child.exitCode === null && !existingAfterLock.stopping) {
    return releaseLockAndReturn({ ready: null });
  }
  const registeredAfterLock = readRegistry(deploymentId);
  if (registeredAfterLock && (registeredAfterLock.status === 'running' || registeredAfterLock.status === 'provisioning')) {
    void persist(deploymentId, registeredAfterLock.status);
    return releaseLockAndReturn({ ready: null });
  }
  let configRedactionValues: string[] = [];
  let launchSpec = spec;
  try {
    if (spec.kind === 'bridge' && spec.command === 'docker' && spec.args[0] === 'run') {
      const config = await materializeDeploymentConfigVolume(deploymentId);
      configRedactionValues = config.redactionValues;
      if (config.hasFiles) launchSpec = withDeploymentConfigVolume(spec, deploymentId);
    }
  } catch (error) {
    releaseLaunchLock();
    await persist(deploymentId, 'error');
    throw error;
  }
  if (launchPrevented(deploymentId, workspaceId)) return releaseLockAndReturn({ ready: null });
  const managedSpec: SpawnSpec = launchSpec.kind === 'bridge'
    && launchSpec.command === 'docker'
    && launchSpec.args[0] === 'run'
    ? {
        ...launchSpec,
        args: ['run', '--name', deploymentContainerName(deploymentId), ...launchSpec.args.slice(1)],
      }
    : launchSpec;
  const script = managedSpec.kind === 'bridge' ? BRIDGE : managedSpec.kind === 'sandbox' ? SANDBOX_SERVER : BUILTIN;
  const managedBridgeImage = managedSpec.kind === 'bridge' ? bridgeImage(managedSpec) : '';
  // This is deliberately generated after the SpawnSpec is built. It is never
  // stored in that spec, the runtime registry, or the captured log stream.
  const runtimeEventToken = managedSpec.kind === 'bridge' ? randomUUID() : '';
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
          MCP_CONTAINER_NAME: managedSpec.command === 'docker'
            ? deploymentContainerName(deploymentId)
            : '',
          MCP_IMAGE: managedBridgeImage,
          MCP_STARTUP_IDLE_TIMEOUT_MS: String(STARTUP_IDLE_TIMEOUT_MS),
          MCP_STARTUP_MAX_TIMEOUT_MS: String(STARTUP_MAX_TIMEOUT_MS),
          MCP_RUNTIME_EVENT_TOKEN: runtimeEventToken,
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

  // A deployment launch owns one log generation. Reset before the child can
  // write stderr so a previous failure cannot be mistaken for this launch.
  resetRuntimeLog(deploymentId);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    releaseLaunchLock();
    throw error;
  }

  const runtime = initialRuntimeRecord(deploymentId, managedSpec, child.pid);
  writeRuntimeRecord(runtime);
  const entry: Entry = {
    child,
    port: null,
    status: 'provisioning',
    pid: child.pid,
    name: managedSpec.name,
    stopGraceMs: managedSpec.kind === 'sandbox' && managedSpec.sandboxKind === 'hermes' ? 35_000 : undefined,
    runtime,
    redactionValues: [
      ...redactionValuesForSpec(managedSpec),
      ...configRedactionValues,
      ...(runtimeEventToken ? [runtimeEventToken] : []),
    ].filter((value, index, values) => values.indexOf(value) === index).sort((a, b) => b.length - a.length),
    runtimeEventToken,
    stderrBuffer: '',
    stderrDecoder: new StringDecoder('utf8'),
    discardingOverlongStderrLine: false,
  };
  s.set(deploymentId, entry);
  try {
    if (child.pid) {
      writeRegistry({
        deploymentId,
        name: managedSpec.name,
        pid: child.pid,
        port: null,
        status: 'provisioning',
        updatedAt: new Date().toISOString(),
        ...runtimeFields(runtime),
      });
    }
  } catch (error) {
    if (store().get(deploymentId) === entry) s.delete(deploymentId);
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
    releaseLaunchLock();
    throw error;
  }
  releaseLaunchLock();
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
        updateRuntime(entry, { status: 'running', phase: 'ready' }, true);
        void persist(deploymentId, 'running');
        resolve();
      }
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = entry.stderrDecoder.write(buf);
      // Never let a late stderr event from a replaced process write into the
      // replacement's generation.
      if (store().get(deploymentId) !== entry) return;
      captureRuntimeStderr(entry, text);
    });
    const flushCapturedStderr = () => {
      // A restart may create a new generation before the old process closes
      // its stderr pipe. Never append that old tail into the new log file.
      if (store().get(deploymentId) !== entry) return;
      captureRuntimeStderr(entry, entry.stderrDecoder.end());
      flushRuntimeStderr(entry);
    };
    child.stderr?.once('end', flushCapturedStderr);
    child.once('close', flushCapturedStderr);
    child.once('exit', () => resolve());
    child.once('error', () => {
      flushCapturedStderr();
      resolve();
    });
    setTimeout(resolve, READY_TIMEOUT_MS);
  });

  child.on('exit', (code) => {
    entry.status = entry.stopping ? 'stopped' : code === 0 ? 'stopped' : 'error';
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    updateRuntime(entry, {
      status: entry.status,
      phase: entry.status === 'error' ? 'error' : 'stopped',
    }, true);
    void persist(deploymentId, entry.status);
  });
  child.on('error', () => {
    entry.status = entry.stopping ? 'stopped' : 'error';
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    updateRuntime(entry, {
      status: entry.status,
      phase: entry.status === 'error' ? 'error' : 'stopped',
    }, true);
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
    if (e) {
      e.status = 'error';
      updateRuntime(e, { status: 'error', phase: 'error' }, true);
    } else {
      updateDetachedRuntime(deploymentId, { status: 'error', phase: 'error' }, true);
    }
    await persist(deploymentId, 'error');
    throw error;
  }
  deleteRegistry(deploymentId);
  if (e) {
    updateRuntime(e, { status: finalStatus, phase: 'stopped' }, true);
  } else {
    updateDetachedRuntime(deploymentId, { status: finalStatus, phase: 'stopped' }, true);
  }
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
