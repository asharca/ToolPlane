import { AGENT_MCP_TOOL_TIMEOUT_BOUNDS } from "@/lib/agents/constants";

/** Each outer hop waits this much longer so the inner transport reports the timeout. */
export const MCP_TOOL_TIMEOUT_MARGIN_MS = 5_000;

/**
 * Server-side deadline for one tools/call from a pinned Agent revision: the
 * per-MCP override, else the Agent default, else the system default.
 */
export function mcpToolCallDeadlineMs(
  config: {
    mcpToolTimeoutSeconds?: number;
    mcpGrants: readonly { deploymentId: string; toolTimeoutSeconds?: number }[];
  },
  deploymentId: string,
): number {
  const seconds =
    config.mcpGrants.find((grant) => grant.deploymentId === deploymentId)
      ?.toolTimeoutSeconds ??
    config.mcpToolTimeoutSeconds ??
    AGENT_MCP_TOOL_TIMEOUT_BOUNDS.default;
  return seconds * 1_000 + MCP_TOOL_TIMEOUT_MARGIN_MS;
}
