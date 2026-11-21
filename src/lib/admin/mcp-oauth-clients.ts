import "server-only";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/admin";
import { oauthLocations } from "@/lib/remote-mcp/oauth/protocol";
import type {
  McpOAuthAdminOverview,
  McpOAuthClientAuthMethod,
} from "@/lib/remote-mcp/oauth-types";

export async function getMcpOAuthAdminOverview(): Promise<McpOAuthAdminOverview> {
  await requireAdmin();
  const rows = await db.mcpOAuthClient.findMany({ orderBy: { issuer: "asc" } });
  const { redirectUri, clientMetadataUrl } = oauthLocations();
  return {
    redirectUri,
    clientMetadataUrl,
    clients: rows.map((row) => ({
      id: row.id,
      issuer: row.issuer,
      clientId: row.clientId,
      hasSecret: !!row.encryptedSecret,
      authMethod: row.authMethod as McpOAuthClientAuthMethod,
      source: row.source === "manual" ? "manual" : "dynamic",
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
