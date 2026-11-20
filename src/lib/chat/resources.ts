import "server-only";
import {
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { db } from "@/lib/db";
import { isRemoteMcpDeployment } from "@/lib/remote-mcp/classification";
import { listPinnedRemoteMcpTools } from "@/lib/remote-mcp/pinned-connection";
import { liveStatus } from "@/lib/process/supervisor";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { persistDeploymentMcpToolCatalog } from "@/lib/process/mcp-tool-catalog-store";
import { resolveMcpConnectionSpawnSpec } from "@/lib/process/mcp-credentials";
import { mcpHeaderSecrets } from "@/lib/process/mcp-result-redaction";
import {
  filterMcpToolsForAi,
  loadMcpToolPolicies,
} from "@/lib/workspace/mcp-tool-exposure";

function listRemoteDeployments(scope: WorkspaceScope) {
  return db.deployment
    .findMany({
      where: { workspace: workspaceScopeWhere(scope), sandbox: { is: null } },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    })
    .then((deployments) => deployments.filter(isRemoteMcpDeployment));
}

function deploymentName(deployment: {
  name: string | null;
  server: { name: string } | null;
}) {
  return deployment.name ?? deployment.server?.name ?? "Remote MCP";
}

/** Page-render choices: database and supervisor state only, never a remote round trip. */
export async function listChatDeploymentChoices(scope: WorkspaceScope) {
  return (await listRemoteDeployments(scope)).map((deployment) => ({
    id: deployment.id,
    name: deploymentName(deployment),
    status: liveStatus(deployment.id) ?? deployment.status,
  }));
}

// Editor options expose neither connection recipes nor credential values.
export async function listChatDeploymentOptions(scope: WorkspaceScope) {
  const workspaceId = scope.id;
  const remote = await listRemoteDeployments(scope);
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
          const catalog = await listPinnedRemoteMcpTools({
            workspaceId,
            deploymentId: deployment.id,
            definitionChecksum,
          });
          const { spec, redactionValues } = await resolveMcpConnectionSpawnSpec(
            {
              workspaceId,
              deploymentId: deployment.id,
              expectedDefinitionChecksum: definitionChecksum,
            },
          );
          await persistDeploymentMcpToolCatalog(deployment.id, catalog, [
            ...redactionValues,
            ...(spec.kind === "remote" ? mcpHeaderSecrets(spec.headers) : []),
          ]);
          tools = filterMcpToolsForAi(catalog, policy).map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.name,
          }));
        } catch {
          available = false;
        }
      }
      return {
        id: deployment.id,
        name: deploymentName(deployment),
        status,
        available,
        tools,
      };
    }),
  );
}
