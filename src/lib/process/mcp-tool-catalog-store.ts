import "server-only";

import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  redactMcpToolCatalogResult,
  readMcpToolCatalog,
  withMcpToolCatalog,
  type McpToolDefinition,
} from "@/lib/process/mcp-tool-catalog";
import { reconcileMcpToolApproval } from "@/lib/process/mcp-tool-signature";
import { liveRedactionValues } from "@/lib/process/supervisor";
import { resolveMcpEnvironment } from "./mcp-credentials";

/** For every grant row referencing this deployment, detect per-tool
 * description/schema drift against its last-approved signature and pause
 * drifted tools until explicit re-approval. First-time approvals (no stored
 * baseline yet) are silently baselined, never flagged. */
async function syncMcpToolApprovalState(
  deploymentId: string,
  previousTools: readonly McpToolDefinition[],
  liveTools: readonly McpToolDefinition[],
): Promise<void> {
  const previous = new Map(previousTools.map((tool) => [tool.name, tool]));
  const live = new Map(liveTools.map((tool) => [tool.name, tool]));
  const [agentServers, assistantGrants] = await Promise.all([
    db.agentServer.findMany({
      where: { deploymentId },
      select: {
        agentId: true,
        deploymentId: true,
        allowedToolNames: true,
        approvedToolSignatures: true,
        pendingToolChanges: true,
      },
    }),
    db.chatAssistantMcpGrant.findMany({
      where: { deploymentId },
      select: {
        assistantId: true,
        deploymentId: true,
        allowedToolNames: true,
        approvedToolSignatures: true,
        pendingToolChanges: true,
      },
    }),
  ]);
  await Promise.all([
    ...agentServers.map((row) => {
      const result = reconcileMcpToolApproval({
        allowedToolNames: row.allowedToolNames,
        liveTools: live,
        previousTools: previous,
        approvedToolSignatures: row.approvedToolSignatures,
        pendingToolChanges: row.pendingToolChanges,
      });
      if (!result.changed) return Promise.resolve();
      return db.agentServer.update({
        where: {
          agentId_deploymentId: {
            agentId: row.agentId,
            deploymentId: row.deploymentId,
          },
        },
        data: {
          approvedToolSignatures:
            result.approvedToolSignatures as Prisma.InputJsonValue,
          pendingToolChanges:
            result.pendingToolChanges as Prisma.InputJsonValue,
        },
      });
    }),
    ...assistantGrants.map((row) => {
      const result = reconcileMcpToolApproval({
        allowedToolNames: row.allowedToolNames,
        liveTools: live,
        previousTools: previous,
        approvedToolSignatures: row.approvedToolSignatures,
        pendingToolChanges: row.pendingToolChanges,
      });
      if (!result.changed) return Promise.resolve();
      return db.chatAssistantMcpGrant.update({
        where: {
          assistantId_deploymentId: {
            assistantId: row.assistantId,
            deploymentId: row.deploymentId,
          },
        },
        data: {
          approvedToolSignatures:
            result.approvedToolSignatures as Prisma.InputJsonValue,
          pendingToolChanges:
            result.pendingToolChanges as Prisma.InputJsonValue,
        },
      });
    }),
  ]);
}

/** Persist a runtime snapshot without overwriting a concurrent config/env edit. */
export async function persistDeploymentMcpToolCatalog(
  deploymentId: string,
  value: unknown,
  requestRedactionValues: readonly string[] = [],
): Promise<McpToolDefinition[]> {
  let tools: McpToolDefinition[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deployment = await db.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        installCfg: true,
        updatedAt: true,
        source: true,
        workspaceId: true,
      },
    });
    if (!deployment || deployment.source === "sandbox") return [];
    const env = Object.values(
      resolveMcpEnvironment(deployment.installCfg, deployment.workspaceId),
    ).filter(Boolean);
    const currentRedactionValues = liveRedactionValues(deploymentId);
    if (currentRedactionValues === null && requestRedactionValues.length === 0)
      return [];
    const redacted = redactMcpToolCatalogResult(value, [
      ...env,
      ...requestRedactionValues,
      ...(currentRedactionValues ?? []),
    ]);
    if (!redacted.ok) return [];
    tools = redacted.tools;
    const previousTools = readMcpToolCatalog(deployment.installCfg);
    if (isDeepStrictEqual(previousTools, tools)) {
      await syncMcpToolApprovalState(deploymentId, previousTools, tools);
      return tools;
    }
    const updated = await db.deployment.updateMany({
      where: { id: deploymentId, updatedAt: deployment.updatedAt },
      data: {
        installCfg: withMcpToolCatalog(
          deployment.installCfg,
          tools,
        ) as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 1) {
      await syncMcpToolApprovalState(deploymentId, previousTools, tools);
      return tools;
    }
  }
  return tools;
}
