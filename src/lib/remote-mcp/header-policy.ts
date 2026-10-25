const BLOCKED_HEADERS: Record<string, true> = {
  connection: true,
  "content-length": true,
  constructor: true as const,
  host: true,
  "mcp-protocol-version": true,
  "mcp-session-id": true,
  prototype: true,
  "transfer-encoding": true,
  upgrade: true,
  ["__proto__"]: true,
};

/** Shared recipe/transport header policy; protocol and prototype keys are never credentials. */
export function isAllowedRemoteMcpHeaderName(name: string): boolean {
  return (
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
    !Object.hasOwn(BLOCKED_HEADERS, name.toLowerCase())
  );
}
