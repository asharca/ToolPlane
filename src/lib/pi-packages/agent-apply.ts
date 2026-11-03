import "server-only";

import { db } from "@/lib/db";
import {
  AgentRevisionError,
  pinCurrentAgentRevision,
  publishAgentRevisionInTransaction,
} from "@/lib/agents/revisions";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesChecksum,
  type PreparedSessionMcpDefinition,
} from "@/lib/process/mcp-definition";
import { catalogToolNames } from "@/lib/process/mcp-grant-sync";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { z } from "zod";
import {
  requirePluginWorkspace,
  visiblePluginWhere,
} from "@/lib/plugins/catalog";
import { captureNativeRoleModels } from "@/lib/agents/native-role-models";
import { parsePiPackageReleaseManifest } from "./manifest";

export type AgentPackageMcpConnection = {
  deploymentId: string;
  allowedToolNames?: string[];
  prepared: PreparedSessionMcpDefinition;
};

/** Apply exactly one reviewed package over the applied revision, never the mutable draft. */
export async function applyPiPackageToAgent(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  expectedRevisionId: string;
  package: { marketInstallId: string; releaseId: string; integrity: string };
  connections: readonly AgentPackageMcpConnection[];
  syncTarget?: { releaseId: string; requestedById: string };
}) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${input.agentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(input.workspaceId, input.userId, true, tx);
      if (input.syncTarget) {
        const pending = await tx.agentPiPackage.findFirst({
          where: {
            agentId: input.agentId,
            marketInstallId: input.package.marketInstallId,
            targetReleaseId: input.syncTarget.releaseId,
            syncRequestedById: input.syncTarget.requestedById,
            syncStatus: "pending",
            agent: { workspaceId: input.workspaceId },
            marketInstall: {
              targetWorkspaceId: input.workspaceId,
              currentReleaseId: input.syncTarget.releaseId,
              status: "ready",
            },
          },
          select: { agentId: true },
        });
        if (!pending)
          throw new AgentRevisionError("PI_PACKAGE_SYNC_SUPERSEDED");
      }
      const agent = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          runtimeKind: { in: ["pi-sdk", "omp"] },
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
      const connections: AgentPackageMcpConnection[] = [];
      for (const connection of input.connections) {
        if (
          connection.allowedToolNames &&
          new Set(connection.allowedToolNames).size !==
            connection.allowedToolNames.length
        )
          throw new AgentRevisionError("MCP_TOOL_SELECTION_CHANGED");
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
        connections.push({
          ...connection,
          allowedToolNames:
            connection.allowedToolNames === undefined
              ? undefined
              : [
                  ...new Set([
                    ...retainedTools,
                    ...connection.allowedToolNames,
                  ]),
                ],
        });
      }
      if (
        new Set(connections.map(({ deploymentId }) => deploymentId)).size !==
        connections.length
      )
        throw new AgentRevisionError("MCP_TOOL_SELECTION_CHANGED");
      const grants: AgentRevisionConfig["mcpGrants"] = [];
      for (const connection of connections) {
        await tx.$queryRaw`SELECT id FROM "Deployment" WHERE id=${connection.deploymentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
        const deployment = await tx.deployment.findFirst({
          where: {
            id: connection.deploymentId,
            workspaceId: input.workspaceId,
            OR: [{ source: null }, { source: { not: "sandbox" } }],
          },
        });
        if (
          !deployment ||
          mcpDefinitionChecksum(deployment) !==
            connection.prepared.definitionChecksum
        )
          throw new AgentRevisionError("MCP_DEFINITION_CHANGED");
        const catalog = catalogToolNames(deployment.installCfg);
        const requested = z
          .array(z.string().min(1).max(240))
          .max(1_000)
          .refine((names) => new Set(names).size === names.length)
          .parse(connection.allowedToolNames ?? []);
        const allowedToolNames = catalog;
        if (requested.some((name) => !allowedToolNames.includes(name)))
          throw new AgentRevisionError("MCP_TOOL_SELECTION_CHANGED");
        if (
          deployment.mcpToolExposure === "allowlist" &&
          requested.some((name) => !deployment.mcpAllowedTools.includes(name))
        )
          throw new AgentRevisionError("MCP_TOOLS_NOT_EXPOSED");
        await tx.agentServer.upsert({
          where: {
            agentId_deploymentId: {
              agentId: input.agentId,
              deploymentId: deployment.id,
            },
          },
          create: {
            agentId: input.agentId,
            deploymentId: deployment.id,
            allowedToolNames,
          },
          update: { allowedToolNames },
        });
        grants.push({
          deploymentId: deployment.id,
          ...connection.prepared,
          runtimeFilesChecksum: await mcpRuntimeFilesChecksum(
            tx,
            deployment.id,
          ),
          allowedToolNames,
        });
      }
      const install = await tx.marketInstall.findFirst({
        where: {
          id: input.package.marketInstallId,
          targetWorkspaceId: input.workspaceId,
          currentReleaseId: input.package.releaseId,
          status: "ready",
          listing: {
            ...visiblePluginWhere(input.workspaceId),
            status: "published",
            releases: {
              some: {
                id: input.package.releaseId,
                checksum: input.package.integrity,
                reviewStatus: "approved",
              },
            },
          },
        },
        select: {
          id: true,
          currentRelease: { select: { manifest: true, checksum: true } },
        },
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
        update: {
          releaseId: input.package.releaseId,
          syncStatus: "synced",
          targetReleaseId: null,
          syncRequestedById: null,
          syncError: null,
        },
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
            ...(current.config.runtimeKind === "omp" &&
            current.config.subagentMode === "native"
              ? {
                  nativeRoleModels: [
                    ...(current.config.nativeRoleModels ?? []).filter(
                      (role) =>
                        role.marketInstallId !== input.package.marketInstallId,
                    ),
                    ...captureNativeRoleModels([
                      {
                        ...input.package,
                        manifest: parsePiPackageReleaseManifest(
                          install.currentRelease.manifest,
                          install.currentRelease.checksum,
                        ),
                      },
                    ]),
                  ],
                }
              : {}),
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
