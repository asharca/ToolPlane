import { UnsupportedOperationError } from "@a2a-js/sdk/errors";

/** Fixed lifetimes for task file storage and capabilities. */
export const TASK_FILE_LIMITS = {
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  ticketMs: 15 * 60 * 1000,
  uploadMs: 15 * 60 * 1000,
} as const;

/** Source keys of files admitted with a task message. */
export const TASK_INPUT_SOURCE_PREFIX = "input:";

const mib = (bytes: number) => Number((bytes / 1024 ** 2).toFixed(2));
const MESSAGES = {
  FILE_TOO_LARGE: (bytes: number) =>
    `File exceeds the ${mib(bytes)} MiB per-file limit.`,
  TASK_FILE_COUNT_EXCEEDED: (files: number) =>
    `Task files exceed the ${files}-file limit.`,
  STORAGE_QUOTA_EXCEEDED: () => "Storage quota exceeded.",
} as const;
export type TaskFileLimit = keyof typeof MESSAGES;

/**
 * `bound` is the configured limit that was exceeded, in bytes or files.
 * Fixed text only: peers and models may read it, so it never carries URLs or exception strings.
 */
export function taskFileLimitError(
  ...[limit, bound]:
    | [limit: "STORAGE_QUOTA_EXCEEDED"]
    | [limit: Exclude<TaskFileLimit, "STORAGE_QUOTA_EXCEEDED">, bound: number]
) {
  return new UnsupportedOperationError({
    message:
      limit === "STORAGE_QUOTA_EXCEEDED"
        ? MESSAGES[limit]()
        : MESSAGES[limit](bound),
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
