import {
  SANDBOX_MCP_READ_TOOLS,
  SANDBOX_MCP_TOOLS,
  type SandboxMcpTool,
  sandboxMcpExportable,
} from "./mcp-policy";

/** Agent access to an attached (external) sandbox; ordered from least to most. */
export const EXTERNAL_SANDBOX_ACCESS = ["read", "write", "full"] as const;
export type ExternalSandboxAccess = (typeof EXTERNAL_SANDBOX_ACCESS)[number];
export const MAX_EXTERNAL_SANDBOXES = 16;

const WRITE_TOOLS: readonly SandboxMcpTool[] = [
  ...SANDBOX_MCP_READ_TOOLS,
  "write_file",
  "delete_file",
];

export function isExternalSandboxAccess(
  value: unknown,
): value is ExternalSandboxAccess {
  return (EXTERNAL_SANDBOX_ACCESS as readonly unknown[]).includes(value);
}

/** Tools in the sandbox runtime's own catalog order. */
export function externalSandboxTools(
  access: ExternalSandboxAccess,
): SandboxMcpTool[] {
  const allowed =
    access === "full"
      ? SANDBOX_MCP_TOOLS
      : access === "write"
        ? WRITE_TOOLS
        : SANDBOX_MCP_READ_TOOLS;
  return SANDBOX_MCP_TOOLS.filter((tool) => allowed.includes(tool));
}

/** The lower of two access levels: pinned revision access narrowed by the live attachment. */
export function narrowExternalSandboxAccess(
  a: ExternalSandboxAccess,
  b: ExternalSandboxAccess,
): ExternalSandboxAccess {
  return EXTERNAL_SANDBOX_ACCESS[
    Math.min(
      EXTERNAL_SANDBOX_ACCESS.indexOf(a),
      EXTERNAL_SANDBOX_ACCESS.indexOf(b),
    )
  ] as ExternalSandboxAccess;
}

function managedBy(config: unknown): unknown {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).managedBy
    : undefined;
}

/**
 * Platform-managed copies (conversation/endpoint runtimes) and an Agent's own
 * template are never attachable; neither are read-only or legacy host rows.
 */
export function isExternalSandboxCandidate(sandbox: {
  kind: string;
  config?: unknown;
  isAgentTemplate: boolean;
}): boolean {
  return (
    !sandbox.isAgentTemplate &&
    managedBy(sandbox.config) === undefined &&
    sandboxMcpExportable(sandbox)
  );
}

/** Platform-managed runtime and history rows; never eligible as external attachments. */
export function isSessionSandbox(config: unknown): boolean {
  return managedBy(config) !== undefined;
}
