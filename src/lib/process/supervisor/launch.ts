import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  getAgentConcurrencySettings,
  resolveMcpStartupTimeoutSettings,
  resolvePrivateHostsSettings,
} from "@/lib/admin/settings";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/observability/events";
import { remoteMcpConnectionIdentity } from "@/lib/remote-mcp/classification";
import { ensureConnectorBroker } from "@/lib/sandboxes/connector-broker";
import { sandboxContainerName } from "@/lib/sandboxes/runtime";
import {
  prepareSshRuntime,
  removeSshRuntimeDirectory,
  sshRuntimeDirectory,
} from "@/lib/sandboxes/ssh-servers";
import {
  DEPLOYMENT_CONFIG_MOUNT_PATH,
  configVolumeName,
  materializeDeploymentConfigVolume,
} from "../deployment-config-volume";
import {
  deploymentContainerName,
  removeDeploymentContainer,
} from "../deployment-runtime-container";
import type { SpawnSpec } from "../spawn-spec";
import { dockerCliEnv } from "./docker-env";
import {
  type Entry,
  type RuntimeRecord,
  acquireLaunchLock,
  childTerminated,
  deleteRegistry,
  pidAlive,
  readRegistry,
  runtimeFields,
  store,
  updateRuntime,
  writeRegistry,
  writeRuntimeRecord,
} from "./registry";
import {
  captureRuntimeStderr,
  flushRuntimeStderr,
  redactionValuesForSpec,
  resetRuntimeLog,
} from "./runtime-logs";

const BUILTIN = path.join(process.cwd(), "scripts", "mcp-server.mjs");
const BRIDGE = path.join(process.cwd(), "scripts", "mcp-stdio-bridge.mjs");
const REMOTE_BRIDGE = path.join(
  process.cwd(),
  "scripts",
  "mcp-http-bridge.mjs",
);
const SANDBOX_SERVER = path.join(
  process.cwd(),
  "scripts",
  "sandbox-mcp-server.mjs",
);

// The bridge uses progress-aware idle and overall budgets. This supervisor
// timeout only bounds callers that explicitly await readiness; it never marks
// a deployment failed and therefore must not be used as an initialize timeout.
const READY_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 5000;
const KILL_GRACE_MS = 1000;

type LaunchHooks = {
  launchPrevented: (deploymentId: string, workspaceId?: string) => boolean;
  persist: (deploymentId: string, status: string) => Promise<void>;
  mcpRuntimeCredentialIdentity: (spec: SpawnSpec) => string;
};

type LaunchResult = {
  ready: Promise<void> | null;
};

function initialRuntimeRecord(
  deploymentId: string,
  spec: SpawnSpec,
  pid?: number,
): RuntimeRecord {
  const now = new Date().toISOString();
  const containerName =
    spec.kind === "bridge" && spec.command === "docker"
      ? deploymentContainerName(deploymentId)
      : spec.kind === "sandbox" &&
          spec.sandboxKind === "docker" &&
          spec.sandboxId
        ? sandboxContainerName(spec.sandboxId)
        : undefined;
  return {
    deploymentId,
    status: "provisioning",
    phase: spec.kind === "bridge" ? "preparing-image" : "initializing",
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

function bridgeImage(spec: Extract<SpawnSpec, { kind: "bridge" }>): string {
  if (spec.image) return spec.image;
  if (spec.command !== "docker" || spec.args[0] !== "run") return "";

  // Docker specs without an explicit image use argv for bridge readiness checks.
  const optionsWithValue = new Set([
    "--name",
    "--cap-drop",
    "--security-opt",
    "--tmpfs",
    "--pids-limit",
    "--memory",
    "--cpus",
    "--network",
    "--pull",
    "--env",
    "--env-file",
    "-e",
    "--mount",
    "--workdir",
  ]);
  for (let index = 1; index < spec.args.length; index += 1) {
    const value = spec.args[index];
    if (value === "--") return spec.args[index + 1] ?? "";
    if (optionsWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return "";
}

function withDeploymentConfigVolume(
  spec: Extract<SpawnSpec, { kind: "bridge" }>,
  deploymentId: string,
): Extract<SpawnSpec, { kind: "bridge" }> {
  if (spec.command !== "docker" || spec.args[0] !== "run") {
    throw new Error("Runtime files require a Docker-backed MCP deployment.");
  }
  return {
    ...spec,
    args: [
      "run",
      "--mount",
      `type=volume,src=${configVolumeName(deploymentId)},dst=${DEPLOYMENT_CONFIG_MOUNT_PATH},readonly`,
      ...(spec.configWorkingDirectory
        ? ["--workdir", DEPLOYMENT_CONFIG_MOUNT_PATH]
        : []),
      ...spec.args.slice(1),
    ],
  };
}

export async function launchProcess(
  { launchPrevented, persist, mcpRuntimeCredentialIdentity }: LaunchHooks,
  deploymentId: string,
  spec: SpawnSpec,
  workspaceId?: string,
  configSourceDeploymentId?: string,
  expectedConfigChecksum?: string,
): Promise<LaunchResult> {
  const s = store();
  const existing = s.get(deploymentId);
  if (existing && existing.child.exitCode === null && !existing.stopping) {
    return { ready: null };
  }
  const registered = readRegistry(deploymentId);
  if (
    registered &&
    (registered.status === "running" || registered.status === "provisioning")
  ) {
    // Another worker is already responsible for this child. Cross-worker
    // readiness promises are not shareable, so return immediately and let the
    // runtime snapshot polling surface its phase instead of spawning a second
    // container that races for the same deployment identity.
    void persist(deploymentId, registered.status);
    return { ready: null };
  }

  const connectorBroker =
    spec.kind === "sandbox" && spec.sandboxKind === "connector"
      ? await ensureConnectorBroker()
      : null;
  const sshWorkspaceId =
    spec.kind === "sandbox" && spec.sandboxKind === "ssh"
      ? (workspaceId ??
        (
          await db.deployment.findUnique({
            where: { id: deploymentId },
            select: { workspaceId: true },
          })
        )?.workspaceId)
      : undefined;
  let sshRuntime: Awaited<ReturnType<typeof prepareSshRuntime>> | null = null;
  if (launchPrevented(deploymentId, workspaceId)) return { ready: null };
  const releaseLaunchLock = acquireLaunchLock(deploymentId);
  if (!releaseLaunchLock) {
    // The owner may still be between spawn() and its atomic registry write.
    // Do not race it; surface provisioning until that worker publishes a
    // registry or reports its own failure.
    const owner = readRegistry(deploymentId);
    void persist(
      deploymentId,
      owner?.status === "running" || owner?.status === "provisioning"
        ? owner.status
        : "provisioning",
    );
    return { ready: null };
  }
  const releaseLockAndReturn = (result: LaunchResult): LaunchResult => {
    releaseLaunchLock();
    return result;
  };
  if (launchPrevented(deploymentId, workspaceId))
    return releaseLockAndReturn({ ready: null });
  const existingAfterLock = s.get(deploymentId);
  if (
    existingAfterLock &&
    existingAfterLock.child.exitCode === null &&
    !existingAfterLock.stopping
  ) {
    return releaseLockAndReturn({ ready: null });
  }
  const registeredAfterLock = readRegistry(deploymentId);
  if (
    registeredAfterLock &&
    (registeredAfterLock.status === "running" ||
      registeredAfterLock.status === "provisioning")
  ) {
    void persist(deploymentId, registeredAfterLock.status);
    return releaseLockAndReturn({ ready: null });
  }
  let configRedactionValues: string[] = [];
  let launchSpec = spec;
  try {
    // Credentials are written only by the launch-lock holder: a concurrent
    // launch must never rewrite files a live child is reading.
    if (spec.kind === "sandbox" && spec.sandboxKind === "ssh")
      sshRuntime = await prepareSshRuntime({
        sandboxId: spec.sandboxId,
        workspaceId: sshWorkspaceId ?? "",
        deploymentId,
      });
    if (
      spec.kind === "bridge" &&
      spec.command === "docker" &&
      spec.args[0] === "run"
    ) {
      // A bridge can exit after Docker has created the named runtime container.
      // The per-deployment launch lock lets this launch safely clear that stale
      // container before it materializes a replacement configuration volume.
      await removeDeploymentContainer(deploymentId);
      const config = await materializeDeploymentConfigVolume(
        deploymentId,
        configSourceDeploymentId,
        expectedConfigChecksum,
      );
      configRedactionValues = config.redactionValues;
      if (config.hasFiles)
        launchSpec = withDeploymentConfigVolume(spec, deploymentId);
    }
  } catch (error) {
    releaseLaunchLock();
    if (spec.kind === "sandbox" && spec.sandboxKind === "ssh")
      await removeSshRuntimeDirectory(sshRuntimeDirectory(deploymentId));
    await persist(deploymentId, "error");
    throw error;
  }
  if (launchPrevented(deploymentId, workspaceId)) {
    if (sshRuntime) await removeSshRuntimeDirectory(sshRuntime.directory);
    return releaseLockAndReturn({ ready: null });
  }
  const managedSpec: SpawnSpec =
    launchSpec.kind === "bridge" &&
    launchSpec.command === "docker" &&
    launchSpec.args[0] === "run"
      ? {
          ...launchSpec,
          args: [
            "run",
            "--name",
            deploymentContainerName(deploymentId),
            ...launchSpec.args.slice(1),
          ],
        }
      : launchSpec;
  const script =
    managedSpec.kind === "bridge"
      ? BRIDGE
      : managedSpec.kind === "remote"
        ? REMOTE_BRIDGE
        : managedSpec.kind === "sandbox"
          ? SANDBOX_SERVER
          : BUILTIN;
  const managedBridgeImage =
    managedSpec.kind === "bridge" ? bridgeImage(managedSpec) : "";
  const startupTimeouts =
    managedSpec.kind === "bridge"
      ? await resolveMcpStartupTimeoutSettings()
      : null;
  const remotePrivateHosts =
    managedSpec.kind === "remote" ? await resolvePrivateHostsSettings() : null;
  // Only Agent sandboxes pin resource limits. Their sessions run concurrently
  // up to the admin per-Agent limit, so memory and process budgets scale with
  // it; CPU stays as pinned. Applies when the container is (re)created.
  const pinnedLimits =
    managedSpec.kind === "sandbox" ? managedSpec.resourceLimits : undefined;
  const sandboxLimits = pinnedLimits
    ? await getAgentConcurrencySettings().then(({ maxPerAgent }) => ({
        ...pinnedLimits,
        memoryBytes: pinnedLimits.memoryBytes * maxPerAgent,
        pidsLimit: pinnedLimits.pidsLimit * maxPerAgent,
      }))
    : undefined;
  // The token must not enter the SpawnSpec, registry, or captured log stream.
  const runtimeEventToken =
    managedSpec.kind === "bridge" || managedSpec.kind === "remote"
      ? randomUUID()
      : "";
  // Keep app secrets out of the bridge. Deployment-scoped values enter only
  // the bridge process and its stdin bootstrap, never Docker's environment.
  const env =
    managedSpec.kind === "bridge" && startupTimeouts
      ? {
          ...dockerCliEnv(),
          MCP_PORT: "0",
          MCP_NAME: managedSpec.name,
          MCP_COMMAND: managedSpec.command,
          MCP_ARGS: JSON.stringify(managedSpec.args),
          MCP_CHILD_ENV: JSON.stringify(
            managedSpec.containerEnv ?? managedSpec.env,
          ),
          MCP_CONTAINER_NAME:
            managedSpec.command === "docker"
              ? deploymentContainerName(deploymentId)
              : "",
          MCP_IMAGE: managedBridgeImage,
          MCP_STARTUP_IDLE_TIMEOUT_MS: String(startupTimeouts.idleTimeoutMs),
          MCP_STARTUP_MAX_TIMEOUT_MS: String(startupTimeouts.maxTimeoutMs),
          MCP_RUNTIME_EVENT_TOKEN: runtimeEventToken,
        }
      : managedSpec.kind === "remote" && remotePrivateHosts
        ? {
            PATH: process.env.PATH ?? "",
            NODE_ENV: process.env.NODE_ENV ?? "production",
            MCP_PORT: "0",
            MCP_NAME: managedSpec.name,
            MCP_REMOTE_CONFIG: JSON.stringify({
              url: managedSpec.url,
              transport: managedSpec.transport,
              headers: managedSpec.headers,
              timeoutMs: managedSpec.timeoutMs,
              allowUnsafeHttp: managedSpec.allowUnsafeHttp,
            }),
            // Only the bridge sees this admin-controlled setting; deployment
            // config cannot opt individual workspace MCPs into private access.
            MCP_REMOTE_PRIVATE_HOSTS: remotePrivateHosts.value,
            MCP_RUNTIME_EVENT_TOKEN: runtimeEventToken,
          }
        : managedSpec.kind === "sandbox"
          ? {
              PATH: process.env.PATH ?? "",
              NODE_ENV: process.env.NODE_ENV ?? "production",
              HOME: process.env.HOME ?? "",
              DOCKER_HOST: process.env.DOCKER_HOST ?? "",
              DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH ?? "",
              DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY ?? "",
              LANG: process.env.LANG ?? "",
              LC_ALL: process.env.LC_ALL ?? "",
              MCP_PORT: "0",
              MCP_NAME: managedSpec.name,
              SANDBOX_ID: managedSpec.sandboxId,
              SANDBOX_KIND: managedSpec.sandboxKind,
              SANDBOX_SSH_CONFIG: sshRuntime
                ? JSON.stringify(sshRuntime.config)
                : "",
              SANDBOX_IMAGE: managedSpec.image ?? "",
              SANDBOX_VOLUME: managedSpec.volumeName ?? "",
              SANDBOX_NETWORK: managedSpec.network,
              SANDBOX_ALLOW_SUDO: String(managedSpec.allowSudo === true),
              SANDBOX_ENV_JSON: JSON.stringify(managedSpec.env ?? {}),
              SANDBOX_RESOURCE_LIMITS_JSON: sandboxLimits
                ? JSON.stringify(sandboxLimits)
                : "",
              SANDBOX_CONNECTOR_BROKER_URL: connectorBroker?.internalUrl ?? "",
              SANDBOX_CONNECTOR_BROKER_TOKEN:
                connectorBroker?.internalToken ?? "",
              SANDBOX_CONNECTOR_REMOTE_ROOT:
                managedSpec.connector?.remoteRoot ?? "",
              TOOLPLANE_MAX_ATTACHMENT_BYTES:
                process.env.TOOLPLANE_MAX_ATTACHMENT_BYTES ?? "",
            }
          : { ...process.env, MCP_PORT: "0", MCP_NAME: managedSpec.name };

  // A deployment launch owns one log generation. Reset before the child can
  // write stderr so a previous failure cannot be mistaken for this launch.
  resetRuntimeLog(deploymentId);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    releaseLaunchLock();
    if (sshRuntime) await removeSshRuntimeDirectory(sshRuntime.directory);
    throw error;
  }

  const runtime = initialRuntimeRecord(deploymentId, managedSpec, child.pid);
  writeRuntimeRecord(runtime);
  const entry: Entry = {
    child,
    port: null,
    status: "provisioning",
    pid: child.pid,
    name: managedSpec.name,
    runtime,
    redactionValues: [
      ...redactionValuesForSpec(managedSpec),
      ...configRedactionValues,
      ...(runtimeEventToken ? [runtimeEventToken] : []),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((a, b) => b.length - a.length),
    runtimeEventToken,
    remoteConnectionIdentity:
      managedSpec.kind === "remote"
        ? remoteMcpConnectionIdentity(managedSpec)
        : undefined,
    credentialIdentity: mcpRuntimeCredentialIdentity(managedSpec),
    stderrBuffer: "",
    stderrDecoder: new StringDecoder("utf8"),
  };
  s.set(deploymentId, entry);
  try {
    if (child.pid) {
      writeRegistry({
        deploymentId,
        name: managedSpec.name,
        pid: child.pid,
        port: null,
        status: "provisioning",
        updatedAt: new Date().toISOString(),
        ...runtimeFields(runtime),
      });
    }
  } catch (error) {
    if (store().get(deploymentId) === entry) s.delete(deploymentId);
    try {
      child.kill("SIGTERM");
    } catch {
      /* best effort */
    }
    releaseLaunchLock();
    throw error;
  }
  releaseLaunchLock();
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on("data", (buf: Buffer) => {
      const m = /LISTENING (\d+)/.exec(buf.toString());
      if (m) {
        // A buffered readiness line can arrive after stopProcess has already
        // revoked this process. Never let it recreate a running registry or DB
        // status. Per-deployment persistence queues preserve the same ordering
        // when a previously-started running write is still in flight.
        if (
          entry.stopping ||
          child.exitCode !== null ||
          store().get(deploymentId) !== entry
        ) {
          resolve();
          return;
        }
        entry.port = Number(m[1]);
        entry.status = "running";
        updateRuntime(entry, { status: "running", phase: "ready" }, true);
        void persist(deploymentId, "running");
        resolve();
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
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
    child.stderr?.once("end", flushCapturedStderr);
    child.once("close", flushCapturedStderr);
    child.once("exit", () => resolve());
    child.once("error", () => {
      flushCapturedStderr();
      resolve();
    });
    setTimeout(resolve, READY_TIMEOUT_MS);
  });

  child.on("exit", (code, signal) => {
    // Remove materialized SSH credentials unless a newer launch now owns them.
    const current = store().get(deploymentId);
    if (sshRuntime && (!current || current === entry))
      void removeSshRuntimeDirectory(sshRuntime.directory);
    void recordEvent({
      domain: "runtime",
      eventName: "runtime.exit",
      deploymentId,
      outcome: entry.stopping || code === 0 ? "success" : "error",
      attributes: { code, signal, generation: entry.runtime.generation },
    });
    entry.status = entry.stopping
      ? "stopped"
      : code === 0
        ? "stopped"
        : "error";
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    updateRuntime(
      entry,
      {
        status: entry.status,
        phase: entry.status === "error" ? "error" : "stopped",
      },
      true,
    );
    void persist(deploymentId, entry.status);
  });
  child.on("error", () => {
    entry.status = entry.stopping ? "stopped" : "error";
    if (child.pid) deleteRegistry(deploymentId, child.pid);
    if (entry.stopping || store().get(deploymentId) !== entry) return;
    updateRuntime(
      entry,
      {
        status: entry.status,
        phase: entry.status === "error" ? "error" : "stopped",
      },
      true,
    );
    void persist(deploymentId, entry.status);
  });

  // Status persistence is ordered per deployment but deliberately does not
  // hold the lifecycle queue. A stop must be able to signal the local child
  // even while a slow database write is still in flight.
  void persist(deploymentId, "provisioning");
  return { ready };
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childTerminated(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => {
      if (childTerminated(child)) finish(true);
    };
    const timer = setTimeout(() => finish(childTerminated(child)), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (childTerminated(child)) finish(true);
  });
}

export async function terminateChild(
  entry: Entry,
  force: boolean,
): Promise<void> {
  entry.stopping = true;
  entry.status = "stopped";
  if (childTerminated(entry.child)) return;

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    entry.child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
  const graceMs = force ? KILL_GRACE_MS : (entry.stopGraceMs ?? STOP_GRACE_MS);
  if (await waitForChildExit(entry.child, graceMs)) return;

  try {
    entry.child.kill("SIGKILL");
  } catch {
    // Re-check through the exit waiter below.
  }
  if (await waitForChildExit(entry.child, KILL_GRACE_MS)) return;
  throw new Error(`Process ${entry.pid ?? "unknown"} did not terminate.`);
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

export async function terminateRegisteredProcess(
  pid: number,
  force: boolean,
): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (!pidAlive(pid)) return;
    throw error;
  }
  if (await waitForPidExit(pid, force ? KILL_GRACE_MS : STOP_GRACE_MS)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!pidAlive(pid)) return;
    throw error;
  }
  if (await waitForPidExit(pid, KILL_GRACE_MS)) return;
  throw new Error(`Registered process ${pid} did not terminate.`);
}
