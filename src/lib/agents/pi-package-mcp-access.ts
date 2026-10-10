import "server-only";
import type { Prisma } from "@prisma/client";
import { resolvePiPackageMcpPolicy } from "./pi-package-mcp";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";

/** Project only requirements, never the potentially 96 MiB executable manifest. */
export async function readAgentPiPackageMcpPolicy(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
): Promise<PiPackageMcpToolPolicy> {
  const rows = await tx.$queryRaw<
    Array<{
      workspaceId: string;
      listingId: string;
      releaseListingId: string;
      installStatus: string;
      listingStatus: string;
      reviewStatus: string;
      requirements: unknown;
      resourceMap: unknown;
    }>
  >`
    SELECT i."targetWorkspaceId" AS "workspaceId", i."listingId", r."listingId" AS "releaseListingId",
      i.status AS "installStatus", l.status AS "listingStatus", r."reviewStatus",
      r.manifest #> '{package,toolplane,mcp}' AS requirements, i."resourceMap"
    FROM "AgentPiPackage" p JOIN "Agent" a ON a.id = p."agentId"
      JOIN "MarketInstall" i ON i.id = p."marketInstallId"
      JOIN "MarketListing" l ON l.id = i."listingId"
      JOIN "MarketRelease" r ON r.id = p."releaseId"
    WHERE a.id = ${agentId} AND a."workspaceId" = ${workspaceId} AND a."runtimeKind" = 'pi-sdk'
    ORDER BY p."marketInstallId"`;
  const result: PiPackageMcpToolPolicy = {};
  for (const row of rows) {
    if (
      row.workspaceId !== workspaceId ||
      row.listingId !== row.releaseListingId ||
      row.installStatus !== "ready" ||
      row.listingStatus !== "published" ||
      row.reviewStatus !== "approved"
    ) {
      throw new Error("PI_PACKAGE_UNAVAILABLE");
    }
    for (const [deploymentId, tools] of Object.entries(
      resolvePiPackageMcpPolicy(row.requirements, row.resourceMap),
    )) {
      result[deploymentId] = [
        ...new Set([...(result[deploymentId] ?? []), ...tools]),
      ].sort();
    }
  }
  const ids = Object.keys(result);
  if (
    ids.length &&
    (await tx.deployment.count({ where: { id: { in: ids }, workspaceId } })) !==
      ids.length
  ) {
    throw new Error("PI_PACKAGE_MCP_BINDING_REQUIRED");
  }
  return result;
}
