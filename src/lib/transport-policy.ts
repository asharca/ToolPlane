export const DEFAULT_ALLOW_HTTP = false;
export const DEFAULT_A2A_INLINE_BYTES = 32 * 1024;
export const MIN_A2A_INLINE_BYTES = 1024;
export const MAX_A2A_INLINE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_A2A_FILE_BYTES = 10 * 1024 * 1024;
export const MIN_A2A_FILE_BYTES = 1024 * 1024;
export const MAX_A2A_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_A2A_TASK_INPUT_BYTES = 100 * 1024 * 1024;
export const MIN_A2A_TASK_INPUT_BYTES = 1024 * 1024;
export const MAX_A2A_TASK_INPUT_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_A2A_TASK_FILES = 20;
export const MIN_A2A_TASK_FILES = 1;
export const MAX_A2A_TASK_FILES = 100;
export const DEFAULT_A2A_WORKSPACE_FILE_BYTES = 1024 * 1024 * 1024;
export const MIN_A2A_WORKSPACE_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_A2A_WORKSPACE_FILE_BYTES = 1024 * 1024 * 1024 * 1024;

/** Administrator file limits; the task input total excludes published outputs. */
export type A2AFileLimits = {
  a2aFileBytes: number;
  a2aTaskInputBytes: number;
  a2aTaskFiles: number;
  a2aWorkspaceFileBytes: number;
};
export const DEFAULT_A2A_FILE_LIMITS: Readonly<A2AFileLimits> = {
  a2aFileBytes: DEFAULT_A2A_FILE_BYTES,
  a2aTaskInputBytes: DEFAULT_A2A_TASK_INPUT_BYTES,
  a2aTaskFiles: DEFAULT_A2A_TASK_FILES,
  a2aWorkspaceFileBytes: DEFAULT_A2A_WORKSPACE_FILE_BYTES,
};
/** Inclusive ranges, in bytes or files, accepted from administrator settings. */
export const A2A_FILE_LIMIT_RANGES: Readonly<
  Record<keyof A2AFileLimits, readonly [number, number]>
> = {
  a2aFileBytes: [MIN_A2A_FILE_BYTES, MAX_A2A_FILE_BYTES],
  a2aTaskInputBytes: [MIN_A2A_TASK_INPUT_BYTES, MAX_A2A_TASK_INPUT_BYTES],
  a2aTaskFiles: [MIN_A2A_TASK_FILES, MAX_A2A_TASK_FILES],
  a2aWorkspaceFileBytes: [
    MIN_A2A_WORKSPACE_FILE_BYTES,
    MAX_A2A_WORKSPACE_FILE_BYTES,
  ],
};

export type TransportPolicy = { allowHttp: boolean; a2aInlineBytes: number };
export const DEFAULT_TRANSPORT_POLICY: Readonly<TransportPolicy> = {
  allowHttp: DEFAULT_ALLOW_HTTP,
  a2aInlineBytes: DEFAULT_A2A_INLINE_BYTES,
};

export function permitsTransportProtocol(
  protocol: string,
  policy: Pick<TransportPolicy, "allowHttp">,
): boolean {
  return protocol === "https:" || (protocol === "http:" && policy.allowHttp);
}

/** Twenty inline files plus bounded text/protocol overhead; URLs do not consume inline allowance. */
export function a2aTransportBodyBytes(
  policy: Pick<TransportPolicy, "a2aInlineBytes">,
): number {
  return 20 * Math.ceil(policy.a2aInlineBytes / 3) * 4 + 262_144;
}
