export const DEFAULT_ALLOW_HTTP = false;
export const DEFAULT_A2A_INLINE_BYTES = 32 * 1024;
export const MIN_A2A_INLINE_BYTES = 1024;
export const MAX_A2A_INLINE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_A2A_TASK_FILES = 20;
export const MIN_A2A_TASK_FILES = 1;
export const MAX_A2A_TASK_FILES = 100;
/** Administrator limit on files per A2A task. */
export type A2AFileLimits = {
  a2aTaskFiles: number;
};
export const DEFAULT_A2A_FILE_LIMITS: Readonly<A2AFileLimits> = {
  a2aTaskFiles: DEFAULT_A2A_TASK_FILES,
};
/** Inclusive ranges accepted from administrator settings. */
export const A2A_FILE_LIMIT_RANGES: Readonly<
  Record<keyof A2AFileLimits, readonly [number, number]>
> = {
  a2aTaskFiles: [MIN_A2A_TASK_FILES, MAX_A2A_TASK_FILES],
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
