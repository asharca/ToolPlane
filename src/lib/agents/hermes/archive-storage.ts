import "server-only";

import { spawn } from "node:child_process";
import {
  markRuntimeUncertain,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import {
  sandboxSyncContainerName,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import { HERMES_ARCHIVE_IMPORT_TIMEOUT_MS } from "./archive-limits";

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runArchiveDocker(args: string[]): Promise<void> {
  return trackRuntimeOperation(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("docker", args, {
          env: dockerEnvironment(),
          stdio: ["ignore", "ignore", "pipe"],
          signal: runtimeAbortSignal(),
        });
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          markRuntimeUncertain();
          child.kill("SIGKILL");
        }, HERMES_ARCHIVE_IMPORT_TIMEOUT_MS);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.stderr.on("data", (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-32_000);
        });
        child.on("error", finish);
        child.on("close", (code) => {
          finish(
            code === 0
              ? undefined
              : new Error(stderr.trim() || `docker exited with code ${code}`),
          );
        });
      }),
    args[0] === "rm",
  );
}

/** Offline storage only: never starts, projects, or restores a Hermes runtime. */
export async function copyHermesArchiveToVolume(params: {
  directory: string;
  image: string;
  sandboxId: string;
}): Promise<void> {
  const volume = sandboxVolumeName(params.sandboxId);
  const helper = sandboxSyncContainerName(params.sandboxId);
  await runArchiveDocker(["volume", "create", volume]);
  await runArchiveDocker(["rm", "-f", helper]).catch(() => undefined);
  const command = [
    "set -eu",
    "mkdir -p /opt/data",
    "cp -R /tmp/toolplane-import/. /opt/data/",
    'if id hermes >/dev/null 2>&1; then chown -R "$(id -u hermes):$(id -g hermes)" /opt/data; fi',
  ].join(" && ");
  await runArchiveDocker([
    "create",
    "--name",
    helper,
    "--network",
    "none",
    "--label",
    "toolplane.hermes-archive-import=true",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--pids-limit",
    "256",
    "--cpus",
    "2",
    "-v",
    `${volume}:/opt/data`,
    "--entrypoint",
    "/bin/sh",
    params.image,
    "-c",
    command,
  ]);
  try {
    // docker cp also works with a remote Docker socket; bind mounts do not.
    await runArchiveDocker([
      "cp",
      `${params.directory}/.`,
      `${helper}:/tmp/toolplane-import`,
    ]);
    await runArchiveDocker(["start", "--attach", helper]);
  } finally {
    await runArchiveDocker(["rm", "-f", helper]).catch(() => undefined);
  }
}
