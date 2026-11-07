import "server-only";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { getDeployments } from "@/lib/workspace/queries";

/** A workspace MCP deployment a plugin requirement may bind, with its exposed tools. */
export type PluginBindingDeployment = {
  id: string;
  name: string;
  tools: string[];
};

export async function listPluginBindingDeployments(
  workspaceId: string,
): Promise<PluginBindingDeployment[]> {
  const deployments = await getDeployments(workspaceId);
  return deployments.map((deployment) => ({
    id: deployment.id,
    name: deploymentLabel(deployment).name,
    tools: readMcpToolCatalog(deployment.installCfg)
      .filter(
        (tool) =>
          deployment.mcpToolExposure !== "allowlist" ||
          deployment.mcpAllowedTools.includes(tool.name),
      )
      .map((tool) => tool.name),
  }));
}
