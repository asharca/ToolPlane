export const DEFAULT_ALLOW_HTTP = false;
export const DEFAULT_A2A_INLINE_BYTES = 32 * 1024;
export const MIN_A2A_INLINE_BYTES = 1024;
export const MAX_A2A_INLINE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_A2A_FILE_BYTES = 10 * 1024 * 1024;
export const MIN_A2A_FILE_BYTES = 1024 * 1024;
export const MAX_A2A_FILE_BYTES = 100 * 1024 * 1024;

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
