import type { Prisma } from "@prisma/client";
import {
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "../../src/lib/process/mcp-credentials";

type MigrationOptions = { workspaceId: string; apply?: boolean };

const idleStatuses = ["stopped", "error", "setup_required"];

/** Run inside one transaction; a failed CAS must roll back the entire batch. */
export async function migrateMcpCredentials(
  tx: Prisma.TransactionClient,
  { workspaceId, apply = false }: MigrationOptions,
) {
  const rows = await tx.deployment.findMany({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      updatedAt: true,
      installCfg: true,
    },
    orderBy: { id: "asc" },
  });
  if (rows.some((row) => !idleStatuses.includes(row.status))) {
    throw new Error("MCP_MIGRATION_DEPLOYMENTS_NOT_STOPPED");
  }

  let candidates = 0;
  let migrated = 0;
  for (const row of rows) {
    const cfg = row.installCfg;
    if (cfg === null) continue;
    if (typeof cfg !== "object" || Array.isArray(cfg)) {
      throw new Error("MCP_MIGRATION_CONFIG_INVALID");
    }
    const rawEnv = cfg.env;
    if (rawEnv === undefined) {
      // Also validate envelopes without an env field instead of silently skipping.
      resolveMcpEnvironment(cfg, workspaceId);
      continue;
    }
    if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
      throw new Error("MCP_MIGRATION_CONFIG_INVALID");
    }
    const entries = Object.entries(rawEnv);
    if (entries.some(([, value]) => typeof value !== "string")) {
      throw new Error("MCP_MIGRATION_CONFIG_INVALID");
    }
    const env = Object.fromEntries(entries) as Record<string, string>;
    if (!Object.values(env).some((value) => value !== "")) {
      resolveMcpEnvironment(cfg, workspaceId);
      continue;
    }
    // Mixed legacy/encrypted state is ambiguous: never overwrite an envelope.
    if (cfg.credentialEnvelope !== undefined) {
      throw new Error("MCP_MIGRATION_CONFIG_INVALID");
    }
    candidates++;
    const sealed = sealMcpEnvironment(cfg, workspaceId, env);
    if (!apply) continue;
    const changed = await tx.deployment.updateMany({
      where: {
        id: row.id,
        workspaceId,
        status: row.status,
        updatedAt: row.updatedAt,
        installCfg: { equals: cfg },
      },
      data: { installCfg: sealed as Prisma.InputJsonObject },
    });
    if (changed.count !== 1) {
      throw new Error("MCP_MIGRATION_CONCURRENT_CHANGE");
    }
    migrated++;
  }
  return {
    mode: apply ? "apply" : "dry-run",
    scanned: rows.length,
    candidates,
    migrated,
  };
}

export function parseMcpMigrationArguments(args: string[]) {
  let workspaceId = "";
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply" && !apply) {
      apply = true;
    } else if (arg === "--workspace" && !workspaceId) {
      workspaceId = args[++index] ?? "";
      if (!workspaceId || workspaceId.startsWith("--")) {
        throw new Error("MCP_MIGRATION_ARGUMENTS_INVALID");
      }
    } else {
      throw new Error("MCP_MIGRATION_ARGUMENTS_INVALID");
    }
  }
  if (!workspaceId) throw new Error("MCP_MIGRATION_ARGUMENTS_INVALID");
  return { workspaceId, apply };
}
