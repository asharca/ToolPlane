import type { Task } from "@a2a-js/sdk";

/**
 * Runtime failures cross the sandbox, task-ledger and browser boundaries as
 * fixed tokens only: `CODE` plus an optional allowlisted reason. Native error
 * text can contain credentials or task content and never escapes.
 */
const FAILURE =
  /^((?:PI|OMP|MCP)_[A-Z0-9_]{1,60})(?=[:\s.]|$)(?::\s*(HTTP_[1-5]\d\d|UNREACHABLE|TIMEOUT|MCP_[A-Z0-9_]{1,40})(?=[\s.]|$))?/;

export type RuntimeFailure = { code: string; reason?: string };

export function parseRuntimeFailure(
  text: string | null | undefined,
): RuntimeFailure | undefined {
  const match = text ? FAILURE.exec(text) : null;
  if (!match) return undefined;
  return match[2] ? { code: match[1], reason: match[2] } : { code: match[1] };
}

export function runtimeFailureText({ code, reason }: RuntimeFailure) {
  return reason ? `${code}: ${reason}` : code;
}

/** The fixed failure recorded in a settled task's status message, if any. */
export function taskRuntimeFailure(task: Task): RuntimeFailure | undefined {
  for (const part of task.status?.message?.parts ?? []) {
    if (part.content?.$case !== "text") continue;
    const failure = parseRuntimeFailure(part.content.value);
    if (failure) return failure;
  }
  return undefined;
}
