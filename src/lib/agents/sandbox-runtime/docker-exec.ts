import "server-only";
import { PiRuntimeInterruptedError } from "../pi-harness";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
  runtimeAbortSignal,
  markRuntimeUncertain,
} from "@/lib/runtime/ownership-state";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { sandboxRuntimeExecWrapper, TURN_TIMEOUT_MS } from "../sandbox-runtime";

export const PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60_000;

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Each platform node process in a shared Agent sandbox otherwise starts one V8
// worker per host core, and every thread counts against the sandbox pids limit.
export const SANDBOX_NODE_FLAG = "--v8-pool-size=1";

export type DockerExecOptions = {
  container: string;
  workdir: string;
  executable: string;
  user?: string;
  args?: string[];
  stdin?: string | Buffer;
  stdinFile?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  secrets?: readonly string[];
  piHarness?: boolean;
};

const uncertainPiSandboxes = new Set<string>();

// `extra` is forwarded into the container via `docker exec --env KEY`, so it
// must win over the host values the Docker CLI itself needs.
export function dockerEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
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
  // A container HOME must not move the host Docker CLI config.
  if (extra.HOME && process.env.HOME)
    env.DOCKER_CONFIG =
      process.env.DOCKER_CONFIG ?? `${process.env.HOME}/.docker`;
  return { ...env, ...extra };
}

export function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (text, secret) => (secret ? text.split(secret).join("[REDACTED]") : text),
    value,
  );
}

export function runDockerOnce(
  args: string[],
  timeoutMs = 10_000,
): Promise<void> {
  assertRuntimeOwner(true);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: dockerEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      markRuntimeUncertain();
      finish(new Error("Docker cleanup timed out."));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.stderr?.once("end", () => {
      stderr += stderrDecoder.end();
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      code === 0
        ? finish()
        : finish(
            new Error(
              stderr.trim() || `Docker cleanup failed (${code ?? "unknown"}).`,
            ),
          ),
    );
  });
}

async function terminateDockerExec(
  container: string,
  pid: number | null,
  pidFile: string,
  confirm = false,
): Promise<void> {
  const script = `
pid=$1
pid_file=$2
if [ -z "$pid" ] && [ -r "$pid_file" ]; then pid=$(cat "$pid_file" 2>/dev/null || true); fi
rm -f -- "$pid_file"
case "$pid" in ''|*[!0-9]*) exit 3 ;; esac
pids=''
kill_tree() {
  for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do kill_tree "$child"; done
  pids="$pids $1"
  kill -KILL "$1" 2>/dev/null || true
}
kill_tree "$pid"
if [ "$3" = confirm ]; then
  for stopped in $pids; do
    attempts=0
    while kill -0 "$stopped" 2>/dev/null; do
      stat=$(cat "/proc/$stopped/stat" 2>/dev/null || true)
      case "$stat" in ''|*') Z '*) break ;; esac
      attempts=$((attempts + 1))
      [ "$attempts" -lt 50 ] || exit 4
      sleep 0.1
    done
  done
fi
`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await runDockerOnce([
        "exec",
        container,
        "sh",
        "-c",
        script,
        "toolplane-kill",
        pid == null ? "" : String(pid),
        pidFile,
        confirm ? "confirm" : "",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (confirm) {
    uncertainPiSandboxes.add(container);
    markRuntimeUncertain();
    throw new Error(
      "PI_PROCESS_STOP_UNCONFIRMED: runtime owner recovery is required before reopening this sandbox.",
    );
  }
}

export function runTrackedDockerExec(
  options: DockerExecOptions,
): Promise<string> {
  const ownerSignal = runtimeAbortSignal();
  const signal = ownerSignal
    ? options.signal
      ? AbortSignal.any([options.signal, ownerSignal])
      : ownerSignal
    : options.signal;
  return trackRuntimeOperation(() =>
    runTrackedDockerExecOwned({ ...options, signal }),
  );
}

function runTrackedDockerExecOwned(
  options: DockerExecOptions,
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Sandbox runtime aborted."));
  const commandEnv = options.env ?? {};
  for (const [key, value] of Object.entries(commandEnv)) {
    if (!ENV_NAME.test(key) || value.includes("\0"))
      throw new Error("Invalid sandbox runtime environment.");
  }
  const executionId = randomUUID();
  const controlPrefix = `__TOOLPLANE_RUNTIME_PID_${executionId}__`;
  const pidFile = `/tmp/toolplane-runtime-${executionId}.pid`;
  const wrapper = sandboxRuntimeExecWrapper(controlPrefix);
  const dockerArgs = [
    "exec",
    "-i",
    ...(options.user ? ["--user", options.user] : []),
    "-w",
    options.workdir,
    ...Object.keys(commandEnv).flatMap((key) => ["--env", key]),
    options.container,
    "sh",
    "-c",
    wrapper,
    "toolplane-runtime",
    pidFile,
    options.executable,
    ...(options.args ?? []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerArgs, {
      env: dockerEnv(commandEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const secrets = options.secrets ?? [];
    const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    let stdout = "";
    let stderr = "";
    let prelude = "";
    let preludeDone = false;
    let innerPid: number | null = null;
    let stopError: Error | null = null;
    let stopping: Promise<void> | null = null;
    let terminationError: unknown;
    let aborted = false;
    let settled = false;
    let callbackChain = Promise.resolve();
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let inputTransfer: Promise<void> | undefined;

    const terminate = () => {
      if (stopping) return;
      stopping = terminateDockerExec(
        options.container,
        innerPid,
        pidFile,
        Boolean(options.piHarness || options.stdinFile),
      )
        .catch((error: unknown) => {
          terminationError = error;
        })
        .finally(() => {
          child.kill("SIGKILL");
        });
    };
    const stop = (error: Error) => {
      if (!stopError) stopError = error;
      terminate();
      if (!forceKillTimer)
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const appendStdout = (chunk: string) => {
      if (!chunk) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > maxStdout) {
        stop(new Error("Sandbox runtime output exceeded its limit."));
        return;
      }
      stdout += chunk;
      const onStdout = options.onStdout;
      if (onStdout)
        callbackChain = callbackChain.then(() => onStdout.call(options, chunk));
    };
    const consumeStdout = (chunk: string) => {
      if (preludeDone) return appendStdout(chunk);
      prelude += chunk;
      const newline = prelude.indexOf("\n");
      if (newline < 0) return;
      const firstLine = prelude.slice(0, newline).replace(/\r$/, "");
      const rest = prelude.slice(newline + 1);
      prelude = "";
      preludeDone = true;
      if (firstLine.startsWith(controlPrefix)) {
        const pid = Number(firstLine.slice(controlPrefix.length));
        if (Number.isSafeInteger(pid) && pid > 0) innerPid = pid;
      } else {
        appendStdout(`${firstLine}\n`);
      }
      if (stopError) terminate();
      appendStdout(rest);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if ((options.piHarness || options.stdinFile) && code !== 0 && !spawnError)
        terminate();
      if (inputTransfer) await inputTransfer;
      if (stopping) await stopping;
      if (terminationError) return reject(terminationError);
      try {
        await callbackChain;
      } catch (error) {
        reject(error);
        return;
      }
      if (stopError)
        return reject(
          options.piHarness && aborted
            ? new PiRuntimeInterruptedError(
                "Pi driver stopped before its operation settled.",
                { cause: stopError },
              )
            : stopError,
        );
      if (spawnError)
        return reject(
          options.piHarness &&
            ["EPIPE", "ECONNRESET", "ECONNABORTED"].includes(
              (spawnError as NodeJS.ErrnoException).code ?? "",
            )
            ? new PiRuntimeInterruptedError(
                "Pi driver transport disconnected.",
                { cause: spawnError },
              )
            : spawnError,
        );
      if (code !== 0) {
        const detail = redact(stderr.trim(), secrets);
        if (options.piHarness && (signal || code === 137 || code === 143)) {
          return reject(
            new PiRuntimeInterruptedError(
              detail || "Pi driver process was terminated.",
            ),
          );
        }
        return reject(
          new Error(
            detail ||
              `Sandbox command failed (${signal ?? code ?? "unknown"}).`,
          ),
        );
      }
      resolve(stdout);
    };
    const onAbort = () => {
      aborted = true;
      stop(new Error("Sandbox runtime aborted."));
    };
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            `Sandbox runtime timed out after ${options.timeoutMs ?? TURN_TIMEOUT_MS}ms.`,
          ),
        ),
      options.timeoutMs ?? TURN_TIMEOUT_MS,
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) =>
      consumeStdout(stdoutDecoder.write(chunk)),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.once("error", (error) => void finish(null, null, error));
    child.once("close", (code, signal) => void finish(code, signal));
    if (options.piHarness) {
      const onTransportError = (error: NodeJS.ErrnoException) =>
        stop(
          ["EPIPE", "ECONNRESET", "ECONNABORTED"].includes(error.code ?? "")
            ? new PiRuntimeInterruptedError(
                "Pi driver transport disconnected.",
                { cause: error },
              )
            : error,
        );
      child.stdin?.on("error", onTransportError);
      child.stdout?.on("error", onTransportError);
      child.stderr?.on("error", onTransportError);
    }
    if (options.stdinFile && child.stdin) {
      inputTransfer = pipeline(
        createReadStream(options.stdinFile),
        child.stdin,
      ).catch((error: unknown) =>
        stop(error instanceof Error ? error : new Error(String(error))),
      );
    } else child.stdin?.end(options.stdin ?? "");
  });
}
