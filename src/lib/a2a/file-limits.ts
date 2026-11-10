import { UnsupportedOperationError } from "@a2a-js/sdk/errors";

/** Fixed lifetimes; size and count limits are administrator settings. */
export const TASK_FILE_LIMITS = {
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  ticketMs: 15 * 60 * 1000,
  uploadMs: 15 * 60 * 1000,
} as const;

/** Source keys of files admitted with a task message; only these count toward the task input total. */
export const TASK_INPUT_SOURCE_PREFIX = "input:";

const mib = (bytes: number) => Number((bytes / 1024 ** 2).toFixed(2));
const MESSAGES = {
  FILE_TOO_LARGE: (bytes: number) =>
    `File exceeds the ${mib(bytes)} MiB per-file limit.`,
  TASK_INPUT_BYTES_EXCEEDED: (bytes: number) =>
    `Task input files exceed the ${mib(bytes)} MiB total limit.`,
  TASK_FILE_COUNT_EXCEEDED: (files: number) =>
    `Task files exceed the ${files}-file limit.`,
  WORKSPACE_FILE_BYTES_EXCEEDED: (bytes: number) =>
    `Workspace task file storage exceeds the ${mib(bytes)} MiB limit.`,
} as const;
export type TaskFileLimit = keyof typeof MESSAGES;

/**
 * `bound` is the configured limit that was exceeded, in bytes or files.
 * Fixed text only: peers and models may read it, so it never carries URLs or exception strings.
 */
export function taskFileLimitError(limit: TaskFileLimit, bound: number) {
  return new UnsupportedOperationError({
    message: MESSAGES[limit](bound),
    metadata: { toolplaneFileLimit: limit },
  });
}

export function taskFileLimit(error: unknown): TaskFileLimit | undefined {
  const limit =
    error instanceof UnsupportedOperationError
      ? error.metadata?.toolplaneFileLimit
      : undefined;
  return limit && Object.hasOwn(MESSAGES, limit)
    ? (limit as TaskFileLimit)
    : undefined;
}
