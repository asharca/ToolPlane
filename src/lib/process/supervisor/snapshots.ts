import "server-only";

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import type {
  DeploymentRuntimeLogChunk,
  DeploymentRuntimeSnapshot,
} from "../supervisor";
import { dockerCliEnv } from "./docker-env";
import {
  type RegistryEntry,
  type RuntimeRecord,
  registryDiffersFromRuntime,
  runtimeLogPath,
} from "./registry";

const RUNTIME_LOG_CHUNK_MAX_BYTES = 64 * 1024;
const RUNTIME_LOG_CHUNK_DEFAULT_BYTES = 16 * 1024;
const DOCKER_LOG_TIMEOUT_MS = 5000;

export function snapshotFromRuntime(
  record: RuntimeRecord,
): DeploymentRuntimeSnapshot {
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

export function readRuntimeLog(deploymentId: string): string {
  try {
    return existsSync(runtimeLogPath(deploymentId))
      ? readFileSync(runtimeLogPath(deploymentId), "utf8")
      : "";
  } catch {
    return "";
  }
}

function registryGeneration(entry: RegistryEntry): string {
  // A PID-scoped generation lets clients reset their cursor when a process
  // without a recorded generation is replaced.
  return entry.generation ?? `legacy-${entry.pid}`;
}

export function snapshotFromRegistry(
  entry: RegistryEntry,
): DeploymentRuntimeSnapshot {
  return {
    status: entry.status,
    phase:
      entry.phase ?? (entry.status === "running" ? "ready" : "initializing"),
    generation: registryGeneration(entry),
    ...(entry.containerName ? { containerName: entry.containerName } : {}),
    ...(entry.containerState ? { containerState: entry.containerState } : {}),
    ...(entry.imageState ? { imageState: entry.imageState } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.lastActivityAt ? { lastActivityAt: entry.lastActivityAt } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function boundedLogLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return RUNTIME_LOG_CHUNK_DEFAULT_BYTES;
  return Math.max(
    1,
    Math.min(RUNTIME_LOG_CHUNK_MAX_BYTES, Math.floor(value as number)),
  );
}

export function readRuntimeLogChunk(
  deploymentId: string,
  runtime: RuntimeRecord | null,
  registry: RegistryEntry | null,
  options: { generation?: string; cursor?: number; limit?: number },
): DeploymentRuntimeLogChunk {
  const registryWins =
    registry !== null &&
    (!runtime || registryDiffersFromRuntime(registry, runtime));
  const generation = registryWins
    ? registryGeneration(registry)
    : (runtime?.generation ?? (registry ? registryGeneration(registry) : null));
  let logSize = 0;
  try {
    logSize = statSync(runtimeLogPath(deploymentId)).size;
  } catch {
    // Missing or unreadable log storage is a best-effort empty chunk.
  }
  const registryLogEnd =
    registryWins && typeof registry.logEndCursor === "number"
      ? registry.logEndCursor
      : undefined;
  const registryLogStart =
    registryWins && typeof registry.logStartCursor === "number"
      ? registry.logStartCursor
      : undefined;
  const logEndCursor = registryLogEnd ?? runtime?.logEndCursor ?? logSize;
  const logStartCursor =
    registryLogStart !== undefined
      ? Math.max(0, Math.min(registryLogStart, logEndCursor))
      : runtime
        ? Math.max(0, Math.min(runtime.logStartCursor, logEndCursor))
        : Math.max(0, logEndCursor - logSize);
  const requestedCursor =
    typeof options.cursor === "number" && Number.isFinite(options.cursor)
      ? Math.max(0, Math.floor(options.cursor))
      : 0;
  let reset =
    options.generation !== undefined && options.generation !== generation;
  let cursor = reset ? logStartCursor : requestedCursor;
  if (cursor < logStartCursor || cursor > logEndCursor) {
    reset = true;
    cursor = logStartCursor;
  }
  const truncated = cursor === logStartCursor && logStartCursor > 0;
  const offset = Math.max(0, Math.min(logSize, cursor - logStartCursor));
  const available = Math.min(logSize, logEndCursor - logStartCursor);
  const limit = boundedLogLimit(options.limit);
  let text = "";
  let nextCursor = cursor;
  if (offset < available) {
    let fd: number | undefined;
    try {
      fd = openSync(runtimeLogPath(deploymentId), "r");
      // Three bytes of lookbehind/lookahead suffice for a UTF-8 code point.
      // Never read the whole file just to return a bounded transport page.
      const windowStart = Math.max(0, offset - 3);
      const bytes = Buffer.allocUnsafe(
        Math.min(available - windowStart, limit + 6),
      );
      let read = 0;
      while (read < bytes.byteLength) {
        const count = readSync(
          fd,
          bytes,
          read,
          bytes.byteLength - read,
          windowStart + read,
        );
        if (!count) break;
        read += count;
      }
      let start = Math.min(offset - windowStart, read);
      // Normalize a caller-supplied mid-code-point cursor backwards. Legacy
      // tail files can start mid-code-point; only that unrecoverable prefix
      // must be skipped, retaining the legacy truncation indicator below.
      while (start > 0 && start < read && (bytes[start] & 0xc0) === 0x80)
        start -= 1;
      while (start < read && (bytes[start] & 0xc0) === 0x80) start += 1;
      let end = Math.min(read, start + limit);
      while (end > start && end < read && (bytes[end] & 0xc0) === 0x80)
        end -= 1;
      // A limit smaller than one code point must still make progress. Only
      // this case can exceed the requested limit (by at most three bytes).
      if (end === start && end < read) {
        end += 1;
        while (end < read && (bytes[end] & 0xc0) === 0x80) end += 1;
      }
      cursor = logStartCursor + windowStart + start;
      nextCursor = logStartCursor + windowStart + end;
      text = bytes.toString("utf8", start, end);
    } catch {
      // Keep the cursor retryable when the best-effort file read fails.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return {
    generation,
    cursor,
    nextCursor,
    reset,
    text,
    ...(truncated ? { truncated: true } : {}),
  };
}

type DockerLogsResult = {
  code: number | null;
  text: string;
  error: string | null;
};

export function readDockerLogs(
  containerName: string,
  limit: number,
): Promise<DockerLogsResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(
      "docker",
      ["logs", "--timestamps", "--tail", String(limit), containerName],
      { env: dockerCliEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, text: stdout, error: error || stderr.trim() || null });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* process may have exited */
      }
      finish(null, "docker logs timed out");
    }, DOCKER_LOG_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, code === 0 ? null : null));
  });
}
