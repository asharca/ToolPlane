import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  redactMcpToolCatalogResult,
  readMcpToolCatalog,
  withMcpToolCatalog,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';
import { liveRedactionValues } from '@/lib/process/supervisor';

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
      select: { installCfg: true, updatedAt: true, source: true },
    });
    if (!deployment || deployment.source === 'sandbox') return [];
    const config = deployment.installCfg && typeof deployment.installCfg === 'object' && !Array.isArray(deployment.installCfg)
      ? deployment.installCfg as Record<string, unknown>
      : {};
    const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? Object.values(config.env as Record<string, unknown>)
          .filter((entry): entry is string => typeof entry === 'string' && entry.length >= 4)
      : [];
    const currentRedactionValues = liveRedactionValues(deploymentId);
    if (currentRedactionValues === null && requestRedactionValues.length === 0) return [];
    const redacted = redactMcpToolCatalogResult(value, [
      ...env,
      ...requestRedactionValues,
      ...(currentRedactionValues ?? []),
    ]);
    if (!redacted.ok) return [];
    tools = redacted.tools;
    if (isDeepStrictEqual(readMcpToolCatalog(deployment.installCfg), tools)) return tools;
    const updated = await db.deployment.updateMany({
      where: { id: deploymentId, updatedAt: deployment.updatedAt },
      data: {
        installCfg: withMcpToolCatalog(deployment.installCfg, tools) as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 1) return tools;
  }
  return tools;
}
