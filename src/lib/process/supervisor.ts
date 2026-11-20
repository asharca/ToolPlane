import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { logSystemEvent } from "@/lib/observability/system";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
  runtimeAbortSignal,
  markRuntimeUncertain,
} from "@/lib/runtime/ownership-state";
import { removeDeploymentConfigVolume } from "./deployment-config-volume";
import {
  deploymentContainerName,
  removeDeploymentContainer,
} from "./deployment-runtime-container";
import { removeStaleSessionMcpCaptures } from "./mcp-runtime-image";
import { MCP_NETWORK } from "./sandbox";
import type { SpawnSpec } from "./spawn-spec";
import {
  launchProcess,
  terminateChild,
  terminateRegisteredProcess,
} from "./supervisor/launch";
import {
  deleteRegistry,
  liveRegistry,
  localLiveEntry,
  readRegistry,
  readRegistryFiles,
  readRuntimeRecord,
  registryDiffersFromRuntime,
  registryFromLocalEntry,
  safeId,
  store,
  updateDetachedRuntime,
  updateRuntime,
} from "./supervisor/registry";
import {
  readDockerLogs,
  readRuntimeLog,
  readRuntimeLogChunk,
  snapshotFromRegistry,
  snapshotFromRuntime,
} from "./supervisor/snapshots";

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
  // requested data predates a legacy log file's retained start cursor.
  reset: boolean;
  text: string;
  truncated?: boolean;
};

export type LiveMcpRuntimeSnapshot = {
  port: number;
  generation: string;
  redactionValues: string[];
  remoteConnectionIdentity?: string;
  credentialIdentity?: string;
};

// Keep lifecycle state across module re-evaluation in the same worker.
const g = globalThis as unknown as {
  __mcpSupervisorPersistQueues?: Map<string, Promise<void>>;
  __mcpSupervisorLifecycleQueues?: Map<string, Promise<void>>;
  __mcpSupervisorTombstones?: Set<string>;
  __mcpSupervisorWorkspaceTombstones?: Set<string>;
  __mcpSupervisorCredentialIdentityKey?: Buffer;
  __mcpSupervisorSourceProcesses?: Map<string, Set<string>>;
  __mcpSupervisorProcessSources?: Map<string, string>;
  __mcpSupervisorRemoteSourceProcesses?: Set<string>;
};

/** Process-private comparison only: never persist or publicly serialize this MAC. */
export function mcpRuntimeCredentialIdentity(spec: SpawnSpec): string {
  g.__mcpSupervisorCredentialIdentityKey ??= randomBytes(32);
  const key = g.__mcpSupervisorCredentialIdentityKey;
  const env =
    spec.kind === "bridge"
      ? { ...spec.env, ...spec.containerEnv }
      : spec.kind === "remote"
        ? spec.headers
        : spec.kind === "sandbox"
          ? spec.env
          : {};
  const entries = Object.keys(env)
    .sort()
    .map((name) => [name, env[name]]);
  return createHmac("sha256", key)
    .update(JSON.stringify([spec.kind, entries]))
    .digest("hex");
}

function rememberProcessSource(
  processId: string,
  options: StartProcessOptions,
  spec: SpawnSpec,
): void {
  const sourceId = options.configSourceDeploymentId;
  if (!sourceId || sourceId === processId) return;
  if (launchPrevented(sourceId, options.workspaceId))
    throw new Error("MCP_SOURCE_UNAVAILABLE");
  g.__mcpSupervisorProcessSources ??= new Map();
  g.__mcpSupervisorSourceProcesses ??= new Map();
  const previous = g.__mcpSupervisorProcessSources.get(processId);
  if (previous && previous !== sourceId)
    throw new Error("MCP_SOURCE_IDENTITY_CHANGED");
  const processes =
    g.__mcpSupervisorSourceProcesses.get(sourceId) ?? new Set<string>();
  processes.add(processId);
  g.__mcpSupervisorSourceProcesses.set(sourceId, processes);
  g.__mcpSupervisorProcessSources.set(processId, sourceId);
  if (spec.kind === "remote") {
    g.__mcpSupervisorRemoteSourceProcesses ??= new Set();
    g.__mcpSupervisorRemoteSourceProcesses.add(processId);
  } else g.__mcpSupervisorRemoteSourceProcesses?.delete(processId);
}

async function releaseProcessSource(processId: string): Promise<void> {
  const sourceId = g.__mcpSupervisorProcessSources?.get(processId);
  if (!sourceId) return;
  if (!g.__mcpSupervisorRemoteSourceProcesses?.has(processId)) {
    await removeDeploymentContainer(processId);
    // Session-private secret projections only, never Agent work volumes.
    await removeDeploymentConfigVolume(processId);
  }
  const processes = g.__mcpSupervisorSourceProcesses?.get(sourceId);
  processes?.delete(processId);
  if (processes?.size === 0) g.__mcpSupervisorSourceProcesses?.delete(sourceId);
  g.__mcpSupervisorProcessSources?.delete(processId);
  g.__mcpSupervisorRemoteSourceProcesses?.delete(processId);
}

function sourceStopOperations(
  sourceId: string,
  options?: KillProcessOptions,
): Promise<void>[] {
  const associated = g.__mcpSupervisorSourceProcesses?.get(sourceId);
  return associated
    ? [...associated].map((processId) =>
        options ? killProcess(processId, options) : stopProcess(processId),
      )
    : [];
}

function assertProcessStopsSucceeded(
  results: PromiseSettledResult<unknown>[],
): void {
  const failures: unknown[] = [];
  for (const result of results)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "MCP_SESSION_STOP_FAILED");
}

function persistQueues(): Map<string, Promise<void>> {
  if (!g.__mcpSupervisorPersistQueues)
    g.__mcpSupervisorPersistQueues = new Map();
  return g.__mcpSupervisorPersistQueues;
}

function lifecycleQueues(): Map<string, Promise<void>> {
  if (!g.__mcpSupervisorLifecycleQueues)
    g.__mcpSupervisorLifecycleQueues = new Map();
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
  return (
    tombstones().has(deploymentId) ||
    (workspaceId !== undefined && workspaceTombstones().has(workspaceId))
  );
}

function enqueueLifecycle<T>(
  deploymentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queues = lifecycleQueues();
  const previous = queues.get(deploymentId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => trackRuntimeOperation(operation, true));
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

async function persist(deploymentId: string, status: string) {
  if (g.__mcpSupervisorProcessSources?.has(deploymentId)) return;
  const queues = persistQueues();
  const previous = queues.get(deploymentId) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await db.deployment.update({
          where: { id: deploymentId },
          data: { status },
        });
      } catch (error) {
        // P2025 means deletion won the status-write race; all other failures need diagnosis.
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2025"
          )
        )
          logSystemEvent("runtime.process.status_write_failed", {
            domain: "runtime",
            deploymentId,
            error,
          });
      }
    });
  queues.set(deploymentId, write);
  await write;
  if (queues.get(deploymentId) === write) {
    queues.delete(deploymentId);
  }
}

export function getDeploymentRuntimeSnapshot(
  deploymentId: string,
): DeploymentRuntimeSnapshot | null {
  const local = localLiveEntry(deploymentId);
  // A process can be owned by another Next worker. In that case never serve a
  // permanently cached runtime record: its worker may already have restarted
  // the deployment and replaced both generation and log file.
  const runtime =
    local?.runtime ?? readRuntimeRecord(deploymentId, { fresh: true });
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
  if (runtime.status === "running" || runtime.status === "provisioning") {
    const live = registry ?? (local ? registryFromLocalEntry(local) : null);
    if (!live || (runtime.pid !== undefined && runtime.pid !== live.pid)) {
      return {
        ...snapshotFromRuntime(runtime),
        status: "stopped",
        phase: "stopped",
      };
    }
  }
  return snapshotFromRuntime(runtime);
}

export function getDeploymentRuntimeLogChunk(
  deploymentId: string,
  options: { generation?: string; cursor?: number; limit?: number } = {},
): DeploymentRuntimeLogChunk {
  const local = localLiveEntry(deploymentId);
  const runtime =
    local?.runtime ?? readRuntimeRecord(deploymentId, { fresh: true });
  const registry = readRegistry(deploymentId);
  return readRuntimeLogChunk(deploymentId, runtime, registry, options);
}

export type DeploymentContainerLogs = {
  containerName: string;
  text: string;
  source: "docker" | "captured" | "none";
  error: string | null;
};

export async function getDeploymentContainerLogs(
  deploymentId: string,
  options: { containerName?: string; limit?: number } = {},
): Promise<DeploymentContainerLogs> {
  const containerName =
    options.containerName || deploymentContainerName(deploymentId);
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 500)));
  const docker = await readDockerLogs(containerName, limit);
  if (docker.code === 0) {
    return { containerName, text: docker.text, source: "docker", error: null };
  }

  const captured = readRuntimeLog(deploymentId);
  return {
    containerName,
    text: captured,
    source: captured ? "captured" : "none",
    error: docker.error,
  };
}

// Create the dedicated MCP sandbox network if it doesn't exist (idempotent).
// Called by the runtime owner before reconciliation. Unavailable Docker
// leaves execution unready rather than advertising a healthy runtime.
export function ensureSandboxNetwork(): Promise<void> {
  return trackRuntimeOperation(() =>
    new Promise<void>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        markRuntimeUncertain("DOCKER_COMMAND_TIMEOUT");
        child?.kill("SIGKILL");
        finish(new Error("Sandbox network setup timed out."));
      }, 30_000);
      const launch = (args: string[], done: (code: number | null) => void) => {
        try {
          // Recheck ownership before the mutation, not just before async inspect.
          assertRuntimeOwner();
          child = spawn("docker", args, {
            stdio: "ignore",
            ...(runtimeAbortSignal() ? { signal: runtimeAbortSignal() } : {}),
          });
          child.once("error", () =>
            finish(new Error("Docker is unavailable during runtime recovery.")),
          );
          child.once("exit", (code) => {
            if (!settled) done(code);
          });
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error("Runtime owner unavailable."),
          );
        }
      };
      launch(["network", "inspect", MCP_NETWORK], (code) => {
        if (code === 0) finish();
        else
          launch(["network", "create", MCP_NETWORK], (created) => {
            if (created === 0) finish();
            else
              launch(["network", "inspect", MCP_NETWORK], (exists) =>
                finish(
                  exists === 0
                    ? undefined
                    : new Error("Sandbox network is unavailable."),
                ),
              );
          });
      });
    }).then(removeStaleSessionMcpCaptures),
  );
}

export function liveStatus(deploymentId: string): string | null {
  return liveRegistry(deploymentId)?.status ?? null;
}

// Persisted active states are stale without a live supervised process.
// Terminal states remain valid without a live registry entry.
const ACTIVE_STATES = new Set(["running", "provisioning"]);
export function effectiveStatus(
  deploymentId: string,
  dbStatus: string,
): string {
  const live = liveStatus(deploymentId);
  if (live) return live;
  return ACTIVE_STATES.has(dbStatus) ? "stopped" : dbStatus;
}

export function effectiveStatuses(
  deployments: ReadonlyArray<{ id: string; status: string }>,
): Map<string, string> {
  const statuses = new Map<string, string>();
  const registryFiles = readRegistryFiles();
  for (const deployment of deployments) {
    const local = localLiveEntry(deployment.id);
    const filename = `${safeId(deployment.id)}.json`;
    const registered = registryFiles.has(filename)
      ? readRegistry(deployment.id)
      : null;
    if (
      registered &&
      (!local || registryDiffersFromRuntime(registered, local.runtime))
    ) {
      statuses.set(deployment.id, registered.status);
      continue;
    }
    if (local) {
      statuses.set(deployment.id, local.status);
      continue;
    }
    statuses.set(
      deployment.id,
      registered?.status ??
        (ACTIVE_STATES.has(deployment.status) ? "stopped" : deployment.status),
    );
  }

  return statuses;
}

export function livePort(deploymentId: string): number | null {
  return liveRegistry(deploymentId)?.port ?? null;
}

/**
 * Return one launch-consistent MCP connection snapshot. Secrets only exist in
 * the worker that owns the child process, so a newer cross-worker registry
 * generation must fail closed instead of pairing its port with stale secrets.
 */
export function liveMcpRuntimeSnapshot(
  deploymentId: string,
): LiveMcpRuntimeSnapshot | null {
  const entry = localLiveEntry(deploymentId);
  if (entry?.status !== "running" || !entry.port) return null;
  const persisted = readRegistry(deploymentId);
  if (persisted && registryDiffersFromRuntime(persisted, entry.runtime))
    return null;
  return {
    port: entry.port,
    generation: entry.runtime.generation,
    redactionValues: [...entry.redactionValues],
    remoteConnectionIdentity: entry.remoteConnectionIdentity,
    credentialIdentity: entry.credentialIdentity,
  };
}

/**
 * Return a copy of the launch-private values used to redact this deployment's
 * runtime output. Callers must never persist or log these plaintext values.
 */
export function liveRedactionValues(deploymentId: string): string[] | null {
  const entry = localLiveEntry(deploymentId);
  if (!entry) return null;
  const persisted = readRegistry(deploymentId);
  if (persisted && registryDiffersFromRuntime(persisted, entry.runtime))
    return null;
  return [...entry.redactionValues];
}

type StartProcessOptions = {
  awaitReady?: boolean;
  workspaceId?: string;
  onReady?: () => void | Promise<void>;
  configSourceDeploymentId?: string;
  expectedConfigChecksum?: string;
};

const launchHooks = {
  launchPrevented,
  persist,
  mcpRuntimeCredentialIdentity,
};

async function launchOwnedProcess(
  deploymentId: string,
  spec: SpawnSpec,
  {
    workspaceId,
    configSourceDeploymentId,
    expectedConfigChecksum,
  }: StartProcessOptions,
) {
  if (
    launchPrevented(deploymentId, workspaceId) ||
    (configSourceDeploymentId &&
      launchPrevented(configSourceDeploymentId, workspaceId))
  )
    return { ready: null };
  if (
    workspaceId &&
    !(await db.workspace.findFirst({
      where: { id: workspaceId, status: "active" },
      select: { id: true },
    }))
  )
    return { ready: null };
  // Admission can await the workspace lookup, so recheck the lease before launch.
  assertRuntimeOwner();
  return launchProcess(
    launchHooks,
    deploymentId,
    spec,
    workspaceId,
    configSourceDeploymentId,
    expectedConfigChecksum,
  );
}

export async function startProcess(
  deploymentId: string,
  spec: SpawnSpec,
  options: StartProcessOptions = {},
): Promise<void> {
  assertRuntimeOwner();
  rememberProcessSource(deploymentId, options, spec);
  const { ready } = await enqueueLifecycle(deploymentId, () => {
    rememberProcessSource(deploymentId, options, spec);
    return launchOwnedProcess(deploymentId, spec, options);
  });
  if (ready && options.onReady) {
    void ready
      .then(() => liveStatus(deploymentId) === "running" && options.onReady?.())
      .catch(() => undefined);
  }
  if ((options.awaitReady ?? true) && ready) await ready;
}

async function stopProcessUnlocked(
  deploymentId: string,
  force = false,
  finalStatus = "stopped",
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
      e.status = "error";
      updateRuntime(e, { status: "error", phase: "error" }, true);
    } else {
      updateDetachedRuntime(
        deploymentId,
        { status: "error", phase: "error" },
        true,
      );
    }
    await persist(deploymentId, "error");
    throw error;
  }
  deleteRegistry(deploymentId);
  if (e) {
    updateRuntime(e, { status: finalStatus, phase: "stopped" }, true);
  } else {
    updateDetachedRuntime(
      deploymentId,
      { status: finalStatus, phase: "stopped" },
      true,
    );
  }
  if (e && store().get(deploymentId) === e) store().delete(deploymentId);
  await persist(deploymentId, finalStatus);
  await releaseProcessSource(deploymentId);
}

export async function stopProcess(deploymentId: string): Promise<void> {
  assertRuntimeOwner(true);
  // Enqueue our own signal immediately, without awaiting child cleanup or DB
  // persistence. Still drain every associated stop before returning to writers.
  const results = await Promise.allSettled([
    ...sourceStopOperations(deploymentId),
    enqueueLifecycle(deploymentId, () => stopProcessUnlocked(deploymentId)),
  ]);
  assertProcessStopsSucceeded(results);
}

export async function restartProcess(
  deploymentId: string,
  spec: SpawnSpec,
  options: StartProcessOptions = {},
): Promise<void> {
  assertRuntimeOwner();
  const sources = Promise.allSettled(sourceStopOperations(deploymentId));
  rememberProcessSource(deploymentId, options, spec);
  const { ready } = await enqueueLifecycle(deploymentId, async () => {
    const ownStop = await Promise.allSettled([
      stopProcessUnlocked(deploymentId),
    ]);
    assertProcessStopsSucceeded([...(await sources), ...ownStop]);
    rememberProcessSource(deploymentId, options, spec);
    return launchOwnedProcess(deploymentId, spec, options);
  });
  if (ready && options.onReady) {
    void ready
      .then(() => liveStatus(deploymentId) === "running" && options.onReady?.())
      .catch(() => undefined);
  }
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
  assertRuntimeOwner(true);
  if (options.preventRestart) tombstones().add(deploymentId);
  const results = await Promise.allSettled([
    ...sourceStopOperations(deploymentId, options),
    enqueueLifecycle(deploymentId, () =>
      stopProcessUnlocked(deploymentId, true, options.finalStatus),
    ),
  ]);
  assertProcessStopsSucceeded(results);
}

// Kill every supervised process for a set of deployments (e.g. when a
// workspace is deleted) so no child processes are left orphaned.
export async function killMany(
  deploymentIds: string[],
  options: KillProcessOptions = {},
): Promise<void> {
  await Promise.all(
    deploymentIds.map((id) =>
      killProcess(id, {
        ...options,
        preventRestart: true,
      }),
    ),
  );
}

// Shutdown must be able to stop only this process's children after a lost lease.
export async function shutdownOwnedProcesses(): Promise<void> {
  await Promise.all(
    [...store().entries()].map(async ([id, entry]) => {
      await terminateChild(entry, false);
      deleteRegistry(id, entry.pid);
      if (store().get(id) === entry) store().delete(id);
      // entry.stopping suppresses exit-handler DB updates. Preserve desired state for restart.
    }),
  );
}
