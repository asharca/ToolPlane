import "server-only";
import { db } from "@/lib/db";
import { buildToolSet } from "@/lib/agents/tools";
import type { AgentToolSet } from "@/lib/agents/agent-tool";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { parsePendingToolChanges } from "@/lib/process/mcp-tool-signature";
import {
  callPinnedRemoteMcpTool,
  listPinnedRemoteMcpTools,
  McpToolNotDispatchedError,
} from "@/lib/remote-mcp/pinned-connection";
import { liveStatus } from "@/lib/process/supervisor";
import { loadMcpToolPolicies } from "@/lib/workspace/mcp-tool-exposure";
import { logRequest } from "@/lib/observability/log";
import type { ChatAssistantRevisionConfig } from "./revision-types";
import { ChatServiceError, requireChatRemoteDeployment } from "./service";
// Revision authority is an upper bound. Live grants can only narrow it, and are
// checked again immediately before every remote invocation (including approval).
export async function buildChatToolSet(scope: {
  assistantId: string;
  workspaceId: string;
  userId: string;
  config: ChatAssistantRevisionConfig;
  signal?: AbortSignal;
}): Promise<AgentToolSet> {
  const authorized = await db.chatAssistant.findFirst({
    where: {
      id: scope.assistantId,
      workspaceId: scope.workspaceId,
      workspace: {
        status: "active",
        OR: [
          { ownerId: scope.userId },
          { members: { some: { userId: scope.userId } } },
        ],
      },
    },
    select: { id: true },
  });
  if (!authorized) throw new ChatServiceError(404, "Chat assistant not found");
  const grants = await db.chatAssistantMcpGrant.findMany({
    where: {
      assistantId: scope.assistantId,
      deploymentId: {
        in: scope.config.mcpGrants.map((grant) => grant.deploymentId),
      },
    },
    include: {
      deployment: {
        include: {
          server: { select: { name: true } },
          sandbox: { select: { id: true } },
        },
      },
    },
  });
  for (const grant of grants) {
    if (
      grant.deployment.workspaceId !== scope.workspaceId ||
      grant.deployment.sandbox
    )
      throw new ChatServiceError(403, "Assistant MCP authority is invalid");
    requireChatRemoteDeployment(grant.deployment);
    const pinned = scope.config.mcpGrants.find(
      (candidate) => candidate.deploymentId === grant.deploymentId,
    );
    if (
      !pinned ||
      mcpDefinitionChecksum(grant.deployment) !== pinned.definitionChecksum
    )
      throw new ChatServiceError(
        409,
        "Pinned MCP connection definition changed",
      );
  }
  const tools = await buildToolSet(
    grants.map((grant) => grant.deploymentId),
    scope.workspaceId,
    {
      liveStatus,
      // Pinned discovery prepares remote connections; stopped is not a missing tool grant.
      requireRunning: false,
      loadMcpToolPolicies,
      logRequest,
      onToolExposureDenied: (_deploymentId, toolName) => {
        throw new McpToolNotDispatchedError(
          new ChatServiceError(
            403,
            `MCP tool ${toolName} is not exposed to AI.`,
          ),
        );
      },
      listMcpTools: async (deploymentId) => {
        const pinned = scope.config.mcpGrants.find(
          (grant) => grant.deploymentId === deploymentId,
        );
        if (!pinned)
          throw new ChatServiceError(
            403,
            "Assistant MCP deployment was not approved",
          );
        return listPinnedRemoteMcpTools(
          {
            workspaceId: scope.workspaceId,
            deploymentId,
            definitionChecksum: pinned.definitionChecksum,
          },
          { signal: scope.signal },
        );
      },
      mcpRpc: async (deploymentId, method, params) => {
        const pinned = scope.config.mcpGrants.find(
          (grant) => grant.deploymentId === deploymentId,
        );
        const toolName = params?.name;
        if (!pinned || method !== "tools/call" || typeof toolName !== "string")
          throw new ChatServiceError(
            403,
            "Assistant MCP call was not approved",
          );
        const result = await callPinnedRemoteMcpTool(
          {
            workspaceId: scope.workspaceId,
            deploymentId,
            definitionChecksum: pinned.definitionChecksum,
          },
          toolName,
          params?.arguments as Record<string, unknown>,
          pinned.allowedToolNames,
          { signal: scope.signal },
          async () => {
            const current = await db.chatAssistantMcpGrant.findFirst({
              where: {
                assistantId: scope.assistantId,
                deploymentId,
                assistant: {
                  workspaceId: scope.workspaceId,
                  workspace: {
                    status: "active",
                    OR: [
                      { ownerId: scope.userId, owner: { status: "active" } },
                      {
                        members: {
                          some: {
                            userId: scope.userId,
                            user: { status: "active" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
              include: {
                deployment: {
                  include: {
                    server: { select: { name: true } },
                    sandbox: { select: { id: true } },
                  },
                },
              },
            });
            if (
              !current?.allowedToolNames.includes(toolName) ||
              current.deployment.workspaceId !== scope.workspaceId ||
              current.deployment.sandbox ||
              toolName in parsePendingToolChanges(current.pendingToolChanges)
            )
              throw new ChatServiceError(
                403,
                "Assistant MCP grant was revoked",
              );
            requireChatRemoteDeployment(current.deployment);
            if (
              mcpDefinitionChecksum(current.deployment) !==
              pinned.definitionChecksum
            )
              throw new ChatServiceError(
                409,
                "Pinned MCP connection definition changed",
              );
          },
        );
        if (!result)
          throw new Error(
            "Remote MCP tool returned no result; its effect outcome is unknown",
          );
        return result;
      },
    },
  );
  const approved: AgentToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const origin = tool.toolplaneOrigin;
    if (!origin) continue;
    const pinned = scope.config.mcpGrants.find(
      (grant) => grant.deploymentId === origin.deploymentId,
    );
    const live = grants.find(
      (grant) => grant.deploymentId === origin.deploymentId,
    );
    if (
      !pinned?.allowedToolNames.includes(origin.originalToolName) ||
      !live?.allowedToolNames.includes(origin.originalToolName) ||
      origin.originalToolName in
        parsePendingToolChanges(live.pendingToolChanges)
    )
      continue;
    if (mcpDefinitionChecksum(live.deployment) !== pinned.definitionChecksum)
      throw new ChatServiceError(
        409,
        "Pinned MCP connection definition changed",
      );
    approved[name] = tool;
  }
  return approved;
}
