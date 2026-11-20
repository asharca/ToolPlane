import "server-only";
import {
  MCP_TOOL_TIMEOUT_MARGIN_MS,
  mcpToolCallDeadlineMs,
} from "@/lib/process/mcp-tool-timeout";
import type { AgentRevisionConfig } from "./revision-types";
import { runtimeMcpProxyUrl } from "./runtime-access";
import type { SandboxRuntimeMcpServer } from "./sandbox-runtime";

/**
 * Session MCP proxies for granted deployments, in grant order. The sandbox
 * waits past the proxy's own deadline for the revision's pinned timeout.
 */
export function sessionMcpServers(
  config: AgentRevisionConfig,
  deploymentIds: readonly string[],
): SandboxRuntimeMcpServer[] {
  return deploymentIds.map((deploymentId) => ({
    deploymentId,
    url: runtimeMcpProxyUrl(deploymentId),
    timeoutMs:
      mcpToolCallDeadlineMs(config, deploymentId) + MCP_TOOL_TIMEOUT_MARGIN_MS,
  }));
}
