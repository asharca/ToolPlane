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
import { liveRedactionValues } from "@/lib/process/supervisor";
import { resolveMcpEnvironment } from "./mcp-credentials";

/** Grant sync may publish revisions (slow, imports Agent/Assistant services); never block the listing on it. */
function followCatalog(deploymentId: string) {
  void import("./mcp-grant-sync")
    .then(({ syncDeploymentMcpGrants }) =>
      syncDeploymentMcpGrants(deploymentId),
    )
    .catch(() => undefined);
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
      followCatalog(deploymentId);
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
      followCatalog(deploymentId);
      return tools;
    }
  }
  return tools;
}
