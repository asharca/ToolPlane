import { isOAuthConfig } from "@/lib/remote-mcp/oauth/config";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { proxyMcpRpcRequest } from "@/lib/process/mcp-gateway";

// Gateway: proxy a real MCP JSON-RPC request to the live deployment process
// and record it for observability. POST a JSON-RPC 2.0 envelope, e.g.
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
export const maxDuration = 610;
const handle = withRequestLogging(
  "/api/v1/mcp/[deploymentId]/rpc",
  async function handleRpc(
    req: Request,
    { params }: { params: Promise<{ deploymentId: string }> },
  ) {
    const { deploymentId } = await params;
    const principal = await resolveRequestPrincipal(req);
    // This account endpoint never granted retired toolkit/install credentials.
    if (!principal || principal.credential === "toolkit-token") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const deployment = await db.deployment.findFirst({
      where: {
        id: deploymentId,
        workspace: workspaceAccessWhere(principal.user.id),
      },
      select: {
        id: true,
        workspaceId: true,
        installCfg: true,
        mcpToolExposure: true,
        mcpAllowedTools: true,
        sandbox: {
          select: {
            id: true,
            config: true,
          },
        },
      },
    });
    if (!deployment) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const config = deployment.sandbox?.config;
    if (
      config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      config.readOnly === true
    )
      return NextResponse.json(
        {
          error:
            "Historical Agent runtimes are read-only. Use the session-scoped file endpoint.",
        },
        { status: 410 },
      );
    const { installCfg, ...gateway } = deployment;
    const timeoutMs =
      installCfg && typeof installCfg === "object" && !Array.isArray(installCfg)
        ? installCfg.timeoutMs
        : undefined;
    return proxyMcpRpcRequest(req, {
      ...gateway,
      principalKey: JSON.stringify([
        principal.user.id,
        principal.token?.id ?? "session",
      ]),
      ...(typeof timeoutMs === "number" &&
      Number.isInteger(timeoutMs) &&
      timeoutMs >= 1_000 &&
      timeoutMs <= 600_000
        ? { timeoutMs: timeoutMs + 5_000 }
        : {}),
      oauth: isOAuthConfig(installCfg),
    });
  },
);
export { handle as GET, handle as POST, handle as DELETE };
