import "server-only";
import { db } from "@/lib/db";
import { actionScope } from "@/lib/workspace/action-scope";
import { workspaceScopeWhere } from "@/lib/workspace/scope";
import { startUrl } from "./oauth/protocol";
import type { McpOAuthConnectionSummary } from "./oauth-types";

export async function getMcpOAuthConnectionSummary(input: {
  workspaceId: string;
  workspaceSlug: string;
  deploymentId: string;
}): Promise<McpOAuthConnectionSummary | null> {
  const ctx = await actionScope({ slug: input.workspaceSlug });
  if (!ctx || ctx.ws.id !== input.workspaceId) return null;
  const dep = await db.deployment.findFirst({
    where: {
      id: input.deploymentId,
      workspace: workspaceScopeWhere(ctx.ws),
      source: "remote",
      installCfg: { path: ["authType"], equals: "oauth" },
    },
    select: {
      installCfg: true,
      mcpOAuthCredential: {
        select: {
          status: true,
          accountLabel: true,
          issuer: true,
          scopes: true,
          connectedAt: true,
        },
      },
    },
  });
  if (!dep) return null;
  const row = dep.mcpOAuthCredential;
  const cfg = dep.installCfg as Record<string, unknown>;
  return {
    issuer: row?.issuer ?? (typeof cfg.issuer === "string" ? cfg.issuer : ""),
    status: !row
      ? "not_connected"
      : row.status === "active"
        ? "active"
        : "reauth_required",
    scopes: row?.scopes ?? [],
    accountLabel: row?.accountLabel ?? null,
    connectedAt: row?.connectedAt.toISOString() ?? null,
    startUrl: startUrl(ctx.ws.slug, input.deploymentId),
  };
}
