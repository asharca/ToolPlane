import "server-only";

import { db } from "@/lib/db";
import { applyReviewedAgentMcpGrantsInTransaction } from "@/lib/agents/mutations";
import type { ReviewedAgentMcpConnection } from "@/lib/agents/mutations";
import {
  AgentRevisionError,
  pinCurrentAgentRevision,
  publishAgentRevisionInTransaction,
} from "@/lib/agents/revisions";
import { mcpRuntimeFilesChecksum } from "@/lib/process/mcp-definition";

/** Apply exactly one reviewed package over the applied revision, never the mutable draft. */
export async function applyPiPackageToAgent(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  expectedRevisionId: string;
  package: { marketInstallId: string; releaseId: string; integrity: string };
  connections: readonly ReviewedAgentMcpConnection[];
}) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${input.agentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
      const agent = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          runtimeKind: "pi-sdk",
          retiredAt: null,
          publicRuntimeAllocation: null,
        },
        select: { id: true },
      });
      if (!agent) throw new AgentRevisionError("AGENT_NOT_FOUND");
      const current = await pinCurrentAgentRevision(tx, input.agentId);
      if (current.id !== input.expectedRevisionId)
        throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
      const live = await tx.agentServer.findMany({
        where: { agentId: input.agentId },
        select: {
          deploymentId: true,
          allowedToolNames: true,
          deployment: {
            select: { mcpToolExposure: true, mcpAllowedTools: true },
          },
        },
      });
      const reviewedConnections: ReviewedAgentMcpConnection[] = [];
      for (const connection of input.connections) {
        const retained = current.config.mcpGrants.find(
          (grant) => grant.deploymentId === connection.deploymentId,
        );
        const liveGrant = live.find(
          (grant) => grant.deploymentId === connection.deploymentId,
        );
        const sameDefinition =
          retained !== undefined &&
          retained.definitionChecksum ===
            connection.prepared.definitionChecksum &&
          retained.runtimeImageDigest ===
            connection.prepared.runtimeImageDigest &&
          retained.runtimeFilesChecksum ===
            (await mcpRuntimeFilesChecksum(tx, connection.deploymentId));
        const retainedTools = sameDefinition
          ? retained.allowedToolNames.filter(
              (name) =>
                liveGrant?.allowedToolNames.includes(name) &&
                (liveGrant.deployment.mcpToolExposure !== "allowlist" ||
                  liveGrant.deployment.mcpAllowedTools.includes(name)),
            )
          : [];
        reviewedConnections.push({
          ...connection,
          allowedToolNames: [
            ...new Set([...retainedTools, ...connection.allowedToolNames]),
          ],
        });
      }
      const { grants } = await applyReviewedAgentMcpGrantsInTransaction(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        agentId: input.agentId,
        expectedRevisionId: input.expectedRevisionId,
        connections: reviewedConnections,
      });
      const install = await tx.marketInstall.findFirst({
        where: {
          id: input.package.marketInstallId,
          targetWorkspaceId: input.workspaceId,
          status: "ready",
          listing: {
            kind: "pi-package",
            status: "published",
            OR: [
              { visibility: "public" },
              { publisherWorkspaceId: input.workspaceId },
            ],
            releases: {
              some: {
                id: input.package.releaseId,
                checksum: input.package.integrity,
                reviewStatus: "approved",
              },
            },
          },
        },
        select: { id: true },
      });
      if (!install) throw new AgentRevisionError("PI_PACKAGE_UNAVAILABLE");
      await tx.agentPiPackage.upsert({
        where: {
          agentId_marketInstallId: {
            agentId: input.agentId,
            marketInstallId: input.package.marketInstallId,
          },
        },
        create: {
          agentId: input.agentId,
          marketInstallId: input.package.marketInstallId,
          releaseId: input.package.releaseId,
        },
        update: { releaseId: input.package.releaseId },
      });
      return publishAgentRevisionInTransaction(
        tx,
        input.workspaceId,
        input.agentId,
        {
          expectedRevisionId: input.expectedRevisionId,
          config: {
            ...current.config,
            packages: [
              ...current.config.packages.filter(
                (pin) => pin.marketInstallId !== input.package.marketInstallId,
              ),
              input.package,
            ],
            mcpGrants: [
              ...current.config.mcpGrants.filter(
                (grant) =>
                  !input.connections.some(
                    (connection) =>
                      connection.deploymentId === grant.deploymentId,
                  ),
              ),
              ...grants,
            ],
          },
        },
      );
    },
    { timeout: 120_000 },
  );
}
