import 'server-only';
import { db } from '@/lib/db';

export type McpToolPolicy = {
  mode: 'all' | 'allowlist';
  allowedTools: readonly string[];
};

export type StoredMcpToolPolicy = {
  mcpToolExposure: string;
  mcpAllowedTools: readonly string[];
};

export function mcpToolPolicyFromStored(stored: StoredMcpToolPolicy): McpToolPolicy {
  return {
    mode: stored.mcpToolExposure === 'allowlist' ? 'allowlist' : 'all',
    allowedTools: stored.mcpAllowedTools,
  };
}

export function isMcpToolExposedToAi(
  policy: McpToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy) return false;
  return policy.mode === 'all' || policy.allowedTools.includes(toolName);
}

export function filterMcpToolsForAi<T extends { name: string }>(
  tools: readonly T[],
  policy: McpToolPolicy | undefined,
): T[] {
  return tools.filter((tool) => isMcpToolExposedToAi(policy, tool.name));
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
    },
  });

  return new Map(deployments.map((deployment) => [
    deployment.id,
    mcpToolPolicyFromStored(deployment),
  ]));
}
