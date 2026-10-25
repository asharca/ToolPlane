import "server-only";
import { db } from "@/lib/db";
import { isRemoteMcpDeployment } from "@/lib/remote-mcp/classification";
import { listPinnedRemoteMcpTools } from "@/lib/remote-mcp/pinned-connection";
import { liveStatus } from "@/lib/process/supervisor";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import {
  filterMcpToolsForAi,
  loadMcpToolPolicies,
} from "@/lib/workspace/mcp-tool-exposure";
import { ChatServiceError } from "./service";

// Editor options expose neither connection recipes nor credential values.
export async function listChatDeploymentOptions(
  userId: string,
  workspaceId: string,
) {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) throw new ChatServiceError(404, "Workspace not found");
  const deployments = await db.deployment.findMany({
    where: { workspaceId, sandbox: { is: null } },
    include: { server: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const remote = deployments.filter(isRemoteMcpDeployment);
  const policies = await loadMcpToolPolicies(
    remote.map((deployment) => deployment.id),
    workspaceId,
  );
  return Promise.all(
    remote.map(async (deployment) => {
      const status = liveStatus(deployment.id) ?? deployment.status;
      const policy = policies.get(deployment.id);
      let available = status === "running" && !!policy;
      let tools: Array<{ name: string; description: string }> = [];
      const definitionChecksum = mcpDefinitionChecksum(deployment);
      if (available && policy) {
        try {
          tools = filterMcpToolsForAi(
            await listPinnedRemoteMcpTools({
              workspaceId,
              deploymentId: deployment.id,
              definitionChecksum,
            }),
            policy,
          ).map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.name,
          }));
        } catch {
          available = false;
        }
      }
      return {
        id: deployment.id,
        name: deployment.name ?? deployment.server?.name ?? "Remote MCP",
        status,
        available,
        tools,
        definitionChecksum,
      };
    }),
  );
}
