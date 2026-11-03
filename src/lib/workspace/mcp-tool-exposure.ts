import "server-only";
import { db } from "@/lib/db";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";

export type McpToolPolicy = {
  mode: "all" | "allowlist";
  allowedTools: readonly string[];
  publicInvocable?: boolean;
};

export type StoredMcpToolPolicy = {
  mcpToolExposure: string;
  mcpAllowedTools: readonly string[];
  publicInvocable?: boolean;
};

export function mcpToolPolicyFromStored(
  stored: StoredMcpToolPolicy,
): McpToolPolicy {
  return {
    mode: stored.mcpToolExposure === "allowlist" ? "allowlist" : "all",
    allowedTools: stored.mcpAllowedTools,
    publicInvocable: stored.publicInvocable === true,
  };
}

export function isMcpToolExposedToAi(
  policy: McpToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy) return false;
  return policy.mode === "all" || policy.allowedTools.includes(toolName);
}

export function filterMcpToolsForAi<T extends { name: string }>(
  tools: readonly T[],
  policy: McpToolPolicy | undefined,
): T[] {
  return tools.filter((tool) => isMcpToolExposedToAi(policy, tool.name));
}

/** Granted names that the stored catalog still lists and exposure permits. */
export function exposedMcpToolNames(
  deployment: StoredMcpToolPolicy & { installCfg: unknown },
  allowedToolNames: readonly string[],
): string[] {
  const catalog = new Set(
    readMcpToolCatalog(deployment.installCfg).map((tool) => tool.name),
  );
  const policy = mcpToolPolicyFromStored(deployment);
  return allowedToolNames.filter(
    (name) => catalog.has(name) && isMcpToolExposedToAi(policy, name),
  );
}

export function sameToolNames(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((name) => right.includes(name))
  );
}

export async function loadMcpToolPolicies(
  deploymentIds: readonly string[],
  workspaceId: string,
): Promise<Map<string, McpToolPolicy>> {
  const ids = [...new Set(deploymentIds)];
  if (ids.length === 0) return new Map();

  const deployments = await db.deployment.findMany({
    where: { id: { in: ids }, workspaceId },
    select: {
      id: true,
      mcpToolExposure: true,
      mcpAllowedTools: true,
      publicInvocable: true,
    },
  });

  return new Map(
    deployments.map((deployment) => [
      deployment.id,
      mcpToolPolicyFromStored(deployment),
    ]),
  );
}
