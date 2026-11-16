import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import type { ConnectorDisplay } from "./connector-broker";
import { sandboxContainerName } from "./runtime";
import { DESKTOP_SANDBOX_IMAGE } from "./images";

export type SandboxDisplayInfo = ConnectorDisplay;

const execFileAsync = promisify(execFile);
const leaseWrites = new Map<string, Promise<void>>();
const BRIDGE = `
const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');
const stop = () => { socket.destroy(); process.exit(0); };
socket.on('error', () => process.exit(1));
socket.on('close', stop);
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stdout.on('close', stop);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`;

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const DESKTOP_RFB_PORT_LABEL = "io.toolplane.desktop.rfb-port";
// Xvnc, openbox and Chromium need room beside Pi and the Agent's own commands.
export const DESKTOP_SANDBOX_RESOURCE_LIMITS = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  cpus: 2,
  pidsLimit: 512,
};

/** Image for new desktop Agents; self-hosters may point it at a mirror. */
export function desktopSandboxImage(): string {
  return (
    process.env.TOOLPLANE_DESKTOP_SANDBOX_IMAGE?.trim() || DESKTOP_SANDBOX_IMAGE
  );
}

export async function dockerDesktopInfo(
  sandboxId: string,
): Promise<{ display: SandboxDisplayInfo; port: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "inspect",
        "-f",
        "{{json .Config.Labels}}|{{.State.Running}}",
        sandboxContainerName(sandboxId),
      ],
      { env: dockerEnv(), timeout: 5000, maxBuffer: 64 * 1024 },
    );
    const separator = stdout.lastIndexOf("|");
    if (separator < 0 || stdout.slice(separator + 1).trim() !== "true")
      return null;
    const labels = JSON.parse(stdout.slice(0, separator)) as Record<
      string,
      unknown
    > | null;
    const rawPort = labels?.[DESKTOP_RFB_PORT_LABEL];
    if (typeof rawPort !== "string" || !/^\d+$/.test(rawPort)) return null;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const rawSize = labels?.["io.toolplane.desktop.size"];
    const size =
      typeof rawSize === "string" ? /^(\d+)x(\d+)$/.exec(rawSize) : null;
    const width = size ? Number(size[1]) : null;
    const height = size ? Number(size[2]) : null;
    return {
      port,
      display: {
        id: "desktop",
        label: "Desktop",
        transport: "rfb",
        control: true,
        width:
          width !== null && Number.isSafeInteger(width) && width > 0
            ? width
            : null,
        height:
          height !== null && Number.isSafeInteger(height) && height > 0
            ? height
            : null,
      },
    };
  } catch {
    return null;
  }
}

export async function dockerSandboxDisplays(
  sandboxId: string,
): Promise<SandboxDisplayInfo[]> {
  const desktop = await dockerDesktopInfo(sandboxId);
  return desktop ? [desktop.display] : [];
}

export function openDesktopStream(
  sandboxId: string,
  port: number,
): ChildProcess {
  assertRuntimeOwner();
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid desktop port");
  return spawn(
    "docker",
    [
      "exec",
      "-i",
      sandboxContainerName(sandboxId),
      "node",
      "-e",
      BRIDGE,
      String(port),
    ],
    { env: dockerEnv(), stdio: ["pipe", "pipe", "ignore"] },
  );
}

export async function setDesktopUserControl(
  sandboxId: string,
  expiresAtMs: number | null,
): Promise<void> {
  if (
    expiresAtMs !== null &&
    (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0)
  ) {
    throw new Error("Invalid desktop control expiry");
  }
  // Serialize replacement-session writes and teardown so an old removal cannot
  // erase the new viewer's lease, nor can a pending refresh revive a cleared one.
  const pending = (leaseWrites.get(sandboxId) ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      trackRuntimeOperation(async () => {
        const args =
          expiresAtMs === null
            ? [
                "exec",
                sandboxContainerName(sandboxId),
                "rm",
                "-f",
                "/tmp/.toolplane-desktop/user-control",
              ]
            : [
                "exec",
                sandboxContainerName(sandboxId),
                "sh",
                "-c",
                'mkdir -p /tmp/.toolplane-desktop && printf %s "$1" > /tmp/.toolplane-desktop/user-control',
                "sh",
                String(expiresAtMs),
              ];
        await execFileAsync("docker", args, {
          env: dockerEnv(),
          timeout: 5000,
          maxBuffer: 64 * 1024,
        });
      }, expiresAtMs === null),
    );
  leaseWrites.set(sandboxId, pending);
  try {
    await pending;
  } finally {
    if (leaseWrites.get(sandboxId) === pending) leaseWrites.delete(sandboxId);
  }
}
