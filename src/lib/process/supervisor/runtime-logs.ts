import "server-only";

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { recordEvent } from "@/lib/observability/events";
import { logSystemEvent } from "@/lib/observability/system";
import type { SpawnSpec } from "../spawn-spec";
import {
  type Entry,
  asOptionalRuntimeString,
  ensureRegistryDir,
  runtimeLogPath,
  updateRuntime,
} from "./registry";

type BridgeRuntimeEvent = {
  type?: string;
  token?: string;
  phase?: string;
  containerState?: string;
  imageState?: string;
};

const BRIDGE_RUNTIME_EVENT_PREFIX = "[toolplane-runtime] ";

export function resetRuntimeLog(deploymentId: string): void {
  try {
    ensureRegistryDir();
    writeFileSync(runtimeLogPath(deploymentId), "", { mode: 0o600 });
  } catch (error) {
    // The process can still start if storage is unavailable; deleted records are benign.
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      logSystemEvent("runtime.process.log_reset_failed", {
        domain: "runtime",
        deploymentId,
        error,
      });
  }
}

function secretValuesFromEnv(env: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const value of Object.values(env)) {
    // Even short configured values are confidential; never infer secrecy from
    // length or entropy.
    if (typeof value === "string" && value.length > 0) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function sensitiveArgValues(args: readonly string[]): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 3 && value.length <= 16 * 1024)
      values.add(value);
  };
  const isSensitiveName = (name: string) =>
    /(?:api[_-]?key|token|secret|pass(?:word)?|credential|authorization|cookie|private[_-]?key|client[_-]?secret)/i.test(
      name,
    );

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = /^--?([^=]+)=(.*)$/.exec(arg);
    if (equals && isSensitiveName(equals[1])) add(equals[2]);
    if (
      /^--?(?:api[_-]?key|token|secret|pass(?:word)?|credential|authorization|cookie|private[_-]?key|client[_-]?secret)$/i.test(
        arg,
      )
    ) {
      add(args[index + 1]);
      index += 1;
      continue;
    }
    // Explicit Docker env arguments are confidential, just like structured env.
    if (arg === "-e" || arg === "--env") {
      const pair = args[index + 1];
      const separator = pair?.indexOf("=") ?? -1;
      if (separator >= 0) add(pair.slice(separator + 1));
      index += 1;
    }

    // Credential-bearing URLs are common in SSH and Git MCP configs. Capture
    // only their userinfo components as redaction values; never retain the argv
    // itself in the runtime registry or log.
    for (const match of arg.matchAll(
      /(?:[a-z][a-z0-9+.-]*:\/\/)?([^:/@\s]+):([^@/\s]+)@/gi,
    )) {
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

export function redactionValuesForSpec(spec: SpawnSpec): string[] {
  const values = new Set(
    spec.kind === "bridge" || spec.kind === "sandbox"
      ? secretValuesFromEnv(spec.env)
      : [],
  );
  if (spec.kind === "bridge") {
    for (const value of secretValuesFromEnv(spec.containerEnv ?? {}))
      values.add(value);
    for (const value of sensitiveArgValues(spec.args)) values.add(value);
  } else if (spec.kind === "remote") {
    for (const value of Object.values(spec.headers)) {
      if (!value) continue;
      values.add(value);
      const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
      if (auth?.[1]) values.add(auth[1]);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactRuntimeLog(value: string, secretValues: string[]): string {
  let redacted = value;
  for (const secret of secretValues) {
    redacted = redacted.split(secret).join("[REDACTED]");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret)
      redacted = redacted.split(escaped).join("[REDACTED]");
  }
  // Key/value, JSON, URLs and common token prefixes cover output that echoes a
  // secret without it being present in the deployment's configured env.
  redacted = redacted
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|credential|cookie|private[_-]?key|client[_-]?secret)\s*[=:]\s*)(["']?)[^\s,;&"']+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /("(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|client[_-]?secret)"\s*:\s*")[^"]*(")/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|secret|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g,
      "[REDACTED]",
    );
  return redacted;
}

function appendRuntimeLog(entry: Entry, value: string): string {
  if (!value) return "";
  const redacted = redactRuntimeLog(value, entry.redactionValues);
  const prefix = `[${new Date().toISOString()}] [stderr] `;
  const content = redacted
    .split(/(?<=\n)/)
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("");
  const appended = Buffer.from(content);
  try {
    ensureRegistryDir();
    const file = runtimeLogPath(entry.runtime.deploymentId);
    appendFileSync(file, appended, { mode: 0o600 });
    entry.runtime.logEndCursor += appended.byteLength;
    entry.runtime.logStartCursor = Math.max(
      0,
      entry.runtime.logEndCursor - statSync(file).size,
    );
  } catch (error) {
    // Do not advance the cursor past persisted data; deletion races need no recovery.
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      logSystemEvent("runtime.process.log_write_failed", {
        domain: "runtime",
        deploymentId: entry.runtime.deploymentId,
        error,
      });
  }
  updateRuntime(entry, {}, true);
  return redacted;
}

function recordRuntimeStderr(entry: Entry, value: string): void {
  const redacted = appendRuntimeLog(entry, value);
  if (redacted)
    void recordEvent({
      domain: "runtime",
      eventName: "runtime.stderr",
      deploymentId: entry.runtime.deploymentId,
      level: "info",
      message: redacted.trimEnd(),
      secrets: entry.redactionValues,
      attributes: { generation: entry.runtime.generation, stream: "stderr" },
      detail: { output: redacted },
    });
}

function completeStderrLines(
  value: string,
  terminal: boolean,
): { lines: string[]; tail: string } {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\n" && char !== "\r") continue;
    let end = index + 1;
    if (char === "\r" && value[index + 1] === "\n") {
      end += 1;
      index += 1;
    }
    lines.push(value.slice(start, end));
    start = end;
  }
  const tail = value.slice(start);
  if (terminal && tail) {
    lines.push(tail);
    return { lines, tail: "" };
  }
  return { lines, tail };
}

function formatBridgeRuntimeEvent(event: BridgeRuntimeEvent): string {
  const field = (value: unknown) =>
    typeof value === "string" ? value.replace(/[\r\n]/g, " ") : "";
  const details = [
    `phase=${field(event.phase) || "unknown"}`,
    ...(field(event.imageState) ? [`image=${field(event.imageState)}`] : []),
    ...(field(event.containerState)
      ? [`container=${field(event.containerState)}`]
      : []),
  ];
  return `[toolplane-runtime] ${details.join(" ")}\n`;
}

function updateRuntimeFromBridgeEvent(
  entry: Entry,
  event: BridgeRuntimeEvent,
): void {
  if (event.type !== "phase") return;
  const phase = asOptionalRuntimeString(event.phase);
  const containerState = asOptionalRuntimeString(event.containerState);
  const imageState = asOptionalRuntimeString(event.imageState);
  if (!phase && !containerState && !imageState) return;
  updateRuntime(
    entry,
    {
      ...(phase ? { phase } : {}),
      ...(containerState ? { containerState } : {}),
      ...(imageState ? { imageState } : {}),
    },
    true,
  );
}

function consumeBridgeRuntimeEvent(entry: Entry, line: string): boolean {
  const marker = line.indexOf(BRIDGE_RUNTIME_EVENT_PREFIX);
  if (marker < 0) return false;
  try {
    const event = JSON.parse(
      line.slice(marker + BRIDGE_RUNTIME_EVENT_PREFIX.length).trim(),
    ) as BridgeRuntimeEvent;
    // A containerized MCP can write arbitrary stderr. Only the bridge knows
    // the launch-private token, so an event without it must be treated as an
    // ordinary (redacted) diagnostic rather than trusted lifecycle metadata.
    if (event.type !== "phase" || event.token !== entry.runtimeEventToken)
      return false;
    updateRuntimeFromBridgeEvent(entry, event);
    recordRuntimeStderr(entry, formatBridgeRuntimeEvent(event));
    return true;
  } catch {
    return false;
  }
}

function recordCompleteStderr(
  entry: Entry,
  value: string,
  terminal = false,
): void {
  const { lines, tail } = completeStderrLines(value, terminal);
  let ordinary = "";
  const flushOrdinary = () => {
    if (!ordinary) return;
    recordRuntimeStderr(entry, ordinary);
    ordinary = "";
  };
  for (const line of lines) {
    if (consumeBridgeRuntimeEvent(entry, line)) {
      flushOrdinary();
    } else {
      ordinary += line;
    }
  }
  flushOrdinary();
  entry.stderrBuffer = tail;
}

export function captureRuntimeStderr(entry: Entry, value: string): void {
  if (!value) return;
  entry.stderrBuffer += value;
  // Scan/redact only once a complete line arrives, retaining even very long
  // incomplete lines so secrets split across stream chunks remain private.
  if (/[\r\n]/.test(value)) recordCompleteStderr(entry, entry.stderrBuffer);
}

export function flushRuntimeStderr(entry: Entry): void {
  if (!entry.stderrBuffer) return;
  recordCompleteStderr(entry, entry.stderrBuffer, true);
}
