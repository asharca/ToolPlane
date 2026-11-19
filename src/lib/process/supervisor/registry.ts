import "server-only";

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StringDecoder } from "node:string_decoder";
import { recordEvent } from "@/lib/observability/events";
import { logSystemEvent } from "@/lib/observability/system";
import type { DeploymentRuntimeSnapshot } from "../supervisor";

export type Entry = {
  child: ChildProcess;
  port: number | null;
  status: string;
  pid?: number;
  name: string;
  stopping?: boolean;
  stopGraceMs?: number;
  runtime: RuntimeRecord;
  redactionValues: string[];
  remoteConnectionIdentity?: string;
  credentialIdentity: string;
  // A launch-private capability used only to authenticate lifecycle events
  // emitted by the bridge. It never enters the runtime record or log file.
  runtimeEventToken: string;
  // Hold incomplete stderr lines until they can be redacted as a whole. This
  // is important because a configured secret can arrive split across stream
  // chunks.
  stderrBuffer: string;
  stderrDecoder: StringDecoder;
};

type Store = Map<string, Entry>;

export type RegistryEntry = {
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

export type RuntimeRecord = DeploymentRuntimeSnapshot & {
  deploymentId: string;
  pid?: number;
  logStartCursor: number;
  logEndCursor: number;
};

// Keep live entries and runtime records across module re-evaluation in one worker.
const g = globalThis as unknown as {
  __mcpSupervisor?: Store;
  __mcpSupervisorRuntime?: Map<string, RuntimeRecord>;
};

export function store(): Store {
  if (!g.__mcpSupervisor) g.__mcpSupervisor = new Map();
  return g.__mcpSupervisor;
}

function runtimeStore(): Map<string, RuntimeRecord> {
  if (!g.__mcpSupervisorRuntime) g.__mcpSupervisorRuntime = new Map();
  return g.__mcpSupervisorRuntime;
}

const REGISTRY_DIR =
  process.env.TOOLPLANE_SUPERVISOR_DIR ||
  path.join(os.tmpdir(), "toolplane-supervisor");

const LAUNCH_LOCK_MAX_AGE_MS = 10 * 60_000;

export function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function registryPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.json`);
}

function runtimePath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.runtime.json`);
}

export function runtimeLogPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.log`);
}

function launchLockPath(deploymentId: string): string {
  return path.join(REGISTRY_DIR, `${safeId(deploymentId)}.launch.lock`);
}

export function ensureRegistryDir() {
  mkdirSync(REGISTRY_DIR, { recursive: true });
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
    const lock = JSON.parse(readFileSync(file, "utf8")) as LaunchLockRecord;
    const createdAt =
      typeof lock.createdAt === "string"
        ? Date.parse(lock.createdAt)
        : Number.NaN;
    if (
      !Number.isFinite(createdAt) ||
      Date.now() - createdAt > LAUNCH_LOCK_MAX_AGE_MS
    )
      return true;
    if (
      typeof lock.pid === "number" &&
      Number.isInteger(lock.pid) &&
      lock.pid > 0
    ) {
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

export function acquireLaunchLock(deploymentId: string): (() => void) | null {
  const file = launchLockPath(deploymentId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ensureRegistryDir();
    const nonce = randomUUID();
    let descriptor: number | undefined;
    let ownsLock = false;
    try {
      descriptor = openSync(file, "wx", 0o600);
      ownsLock = true;
      writeFileSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          nonce,
        }),
      );
      closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = JSON.parse(
            readFileSync(file, "utf8"),
          ) as LaunchLockRecord;
          if (current.nonce === nonce) rmSync(file, { force: true });
        } catch {
          // A replacement lock (or already-cleaned lock) is not ours to remove.
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          /* best effort */
        }
      }
      if (ownsLock) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* best effort */
        }
        return null;
      }
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !launchLockIsStale(file)
      ) {
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

export function asOptionalRuntimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function runtimeRecordFromUnknown(
  value: unknown,
  deploymentId: string,
): RuntimeRecord | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.deploymentId !== deploymentId) return null;
  const status = asOptionalRuntimeString(input.status);
  const phase = asOptionalRuntimeString(input.phase);
  const generation = asOptionalRuntimeString(input.generation);
  if (!status || !phase || !generation) return null;
  const numberOr = (field: string, fallback: number) => {
    const candidate = input[field];
    return typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
      ? Math.floor(candidate)
      : fallback;
  };
  const logStartCursor = numberOr("logStartCursor", 0);
  const logEndCursor = Math.max(
    logStartCursor,
    numberOr("logEndCursor", logStartCursor),
  );
  const pid = numberOr("pid", 0);
  return {
    deploymentId,
    status,
    phase,
    generation,
    ...(pid > 0 ? { pid } : {}),
    ...(asOptionalRuntimeString(input.containerName)
      ? { containerName: asOptionalRuntimeString(input.containerName) }
      : {}),
    ...(asOptionalRuntimeString(input.containerState)
      ? { containerState: asOptionalRuntimeString(input.containerState) }
      : {}),
    ...(asOptionalRuntimeString(input.imageState)
      ? { imageState: asOptionalRuntimeString(input.imageState) }
      : {}),
    ...(asOptionalRuntimeString(input.startedAt)
      ? { startedAt: asOptionalRuntimeString(input.startedAt) }
      : {}),
    ...(asOptionalRuntimeString(input.lastActivityAt)
      ? { lastActivityAt: asOptionalRuntimeString(input.lastActivityAt) }
      : {}),
    ...(asOptionalRuntimeString(input.updatedAt)
      ? { updatedAt: asOptionalRuntimeString(input.updatedAt) }
      : {}),
    logStartCursor,
    logEndCursor,
  };
}

export function writeRuntimeRecord(record: RuntimeRecord): void {
  runtimeStore().set(record.deploymentId, record);
  try {
    writeAtomic(runtimePath(record.deploymentId), JSON.stringify(record));
  } catch (error) {
    // Deletion races are benign; keep using the in-memory record on storage outages.
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      logSystemEvent("runtime.process.record_write_failed", {
        domain: "runtime",
        deploymentId: record.deploymentId,
        error,
      });
  }
}

export function readRuntimeRecord(
  deploymentId: string,
  options: { fresh?: boolean } = {},
): RuntimeRecord | null {
  const inMemory = runtimeStore().get(deploymentId);
  if (inMemory && !options.fresh) return inMemory;
  try {
    if (!existsSync(runtimePath(deploymentId))) return null;
    const parsed = runtimeRecordFromUnknown(
      JSON.parse(readFileSync(runtimePath(deploymentId), "utf8")),
      deploymentId,
    );
    if (parsed) runtimeStore().set(deploymentId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function touchRuntime(record: RuntimeRecord, activity = false): void {
  const now = new Date().toISOString();
  if (activity) record.lastActivityAt = now;
  record.updatedAt = now;
}

export function runtimeFields(
  record: RuntimeRecord,
): Pick<
  RegistryEntry,
  | "generation"
  | "phase"
  | "containerName"
  | "containerState"
  | "imageState"
  | "startedAt"
  | "lastActivityAt"
  | "logStartCursor"
  | "logEndCursor"
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

export function updateRuntime(
  entry: Entry,
  update: Partial<
    Pick<
      RuntimeRecord,
      "status" | "phase" | "containerName" | "containerState" | "imageState"
    >
  >,
  activity = false,
): void {
  const changed = Object.entries(update).some(
    ([key, value]) => entry.runtime[key as keyof RuntimeRecord] !== value,
  );
  Object.assign(entry.runtime, update);
  touchRuntime(entry.runtime, activity);
  writeRuntimeRecord(entry.runtime);
  syncRuntimeRegistry(entry);
  if (changed)
    void recordEvent({
      domain: "runtime",
      eventName: "runtime.state",
      deploymentId: entry.runtime.deploymentId,
      outcome: entry.runtime.status === "error" ? "error" : "success",
      attributes: {
        generation: entry.runtime.generation,
        phase: entry.runtime.phase,
        status: entry.runtime.status,
        imageState: entry.runtime.imageState,
        containerState: entry.runtime.containerState,
      },
    });
}

export function updateDetachedRuntime(
  deploymentId: string,
  update: Partial<Pick<RuntimeRecord, "status" | "phase">>,
  activity = false,
): void {
  const runtime = readRuntimeRecord(deploymentId, { fresh: true });
  if (!runtime) return;
  Object.assign(runtime, update);
  touchRuntime(runtime, activity);
  writeRuntimeRecord(runtime);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function childTerminated(child: ChildProcess): boolean {
  return (
    child.exitCode !== null ||
    child.signalCode !== null ||
    (child.pid === undefined ? true : !pidAlive(child.pid))
  );
}

export function readRegistry(deploymentId: string): RegistryEntry | null {
  const file = registryPath(deploymentId);
  if (!existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as RegistryEntry;
    if (entry.deploymentId !== deploymentId || !pidAlive(entry.pid)) {
      rmSync(file, { force: true });
      return null;
    }
    return entry;
  } catch {
    // An unreadable registry is not proof that its owner is gone.
    return null;
  }
}

export function writeRegistry(entry: RegistryEntry) {
  writeAtomic(registryPath(entry.deploymentId), JSON.stringify(entry));
}

export function deleteRegistry(deploymentId: string, pid?: number) {
  const current = readRegistry(deploymentId);
  if (pid && current && current.pid !== pid) return;
  rmSync(registryPath(deploymentId), { force: true });
}

export function localLiveEntry(deploymentId: string): Entry | null {
  const entry = store().get(deploymentId);
  if (!entry || entry.stopping || !entry.pid || childTerminated(entry.child))
    return null;
  return entry;
}

export function registryFromLocalEntry(entry: Entry): RegistryEntry {
  const pid = entry.pid;
  if (pid === undefined) throw new Error("Live process has no PID.");
  return {
    deploymentId: entry.runtime.deploymentId,
    name: entry.name,
    pid,
    port: entry.port,
    status: entry.status,
    updatedAt: new Date().toISOString(),
    ...runtimeFields(entry.runtime),
  };
}

export function liveRegistry(deploymentId: string): RegistryEntry | null {
  const local = localLiveEntry(deploymentId);
  const persisted = readRegistry(deploymentId);
  // A different live PID (or a new generation from another worker) owns the
  // deployment now. Prefer the cross-worker registry over a stale local map.
  if (
    persisted &&
    (!local || registryDiffersFromRuntime(persisted, local.runtime))
  ) {
    return persisted;
  }
  return local ? registryFromLocalEntry(local) : persisted;
}

export function readRegistryFiles(): Set<string> {
  try {
    return new Set(readdirSync(REGISTRY_DIR));
  } catch {
    return new Set<string>();
  }
}

export function registryDiffersFromRuntime(
  entry: RegistryEntry,
  runtime: RuntimeRecord,
): boolean {
  return (
    entry.pid !== runtime.pid ||
    (entry.generation !== undefined && entry.generation !== runtime.generation)
  );
}
