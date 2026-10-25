import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import {
  agentRuntimeTokenFromRequest,
  bindRuntimeLogContext,
} from "@/lib/agents/runtime-access";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import {
  listSessionMcpTools,
  callSessionMcpTool,
} from "@/lib/process/session-mcp";
import { z } from "zod";
import { parseJson } from "@/lib/agents/public-api/body";
import { MarketError } from "@/lib/market/skills";

const preEffectDenials: Record<string, true> = {
  MCP_SESSION_FORBIDDEN: true,
  MCP_REVISION_FORBIDDEN: true,
  MCP_GRANT_REVOKED: true,
  MCP_TOOL_FORBIDDEN: true,
  MCP_TOOL_UNAVAILABLE: true,
  MCP_DEFINITION_CHANGED: true,
  MCP_RUNTIME_FILES_CHANGED: true,
  MCP_IMMUTABLE_IMAGE_REQUIRED: true,
  MCP_CAPTURE_IDENTITY_MISMATCH: true,
  MCP_PREPARATION_REQUIRED: true,
  MCP_SESSION_RECIPE_UNSUPPORTED: true,
  MCP_EXACT_PACKAGE_VERSION_REQUIRED: true,
  MCP_CONNECTION_RESTART_REQUIRED: true,
  MCP_CONNECTION_UNAVAILABLE: true,
  MCP_CREDENTIAL_MIGRATION_REQUIRED: true,
  MCP_CREDENTIAL_SCOPE_INVALID: true,
  MCP_CREDENTIAL_INVALID: true,
  MCP_CREDENTIAL_REQUIRED: true,
  AGENT_CREDENTIAL_REVOKED: true,
};

export const runtime = "nodejs";
export const maxDuration = 60;
const runtimeRpc = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z
      .union([z.string().max(200), z.number().finite(), z.null()])
      .optional(),
    method: z.string().min(1).max(80),
    params: z.json().optional(),
  })
  .strict();

export const POST = withRequestLogging(
  "/api/v1/agent-runtime/mcp/[deploymentId]/rpc",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ deploymentId: string }> },
  ) {
    const token = await agentRuntimeTokenFromRequest(req);
    if (!token)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { deploymentId } = await params;
    if (!token.deploymentIds.includes(deploymentId)) {
      return NextResponse.json(
        { error: "deployment is outside the runtime grant" },
        { status: 403 },
      );
    }
    const grant = await resolveAgentRuntimeGrant(token);
    if (!grant) {
      return NextResponse.json(
        { error: "runtime grant is no longer valid" },
        { status: 403 },
      );
    }

    bindRuntimeLogContext(token);
    const context = {
      workspaceId: token.workspaceId,
      agentId: token.agentId,
      agentRevisionId: token.agentRevisionId,
      ...(token.a2aContextId
        ? { a2aContextId: token.a2aContextId }
        : { conversationId: token.conversationId }),
    };
    const parsed = await parseJson(req, runtimeRpc, 1_048_576);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: "invalid JSON-RPC request" },
        { status: parsed.reason === "too_large" ? 413 : 400 },
      );
    }
    const body = parsed.value;
    const id = body.id ?? null;
    try {
      if (body.method === "initialize") {
        return NextResponse.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "ToolPlane session MCP", version: "1.0.0" },
          },
        });
      }
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (body.method === "ping")
        return NextResponse.json({ jsonrpc: "2.0", id, result: {} });
      if (body.method === "tools/list") {
        const tools = await listSessionMcpTools(context, deploymentId);
        return NextResponse.json({ jsonrpc: "2.0", id, result: { tools } });
      }
      if (body.method === "tools/call") {
        const params = "params" in body ? body.params : null;
        if (
          !params ||
          typeof params !== "object" ||
          !("name" in params) ||
          typeof params.name !== "string"
        ) {
          return NextResponse.json(
            {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Invalid tool parameters" },
            },
            { status: 400 },
          );
        }
        const args = "arguments" in params ? params.arguments : {};
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return NextResponse.json(
            {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Invalid tool arguments" },
            },
            { status: 400 },
          );
        }
        const result = await callSessionMcpTool(
          context,
          deploymentId,
          params.name,
          args as Record<string, unknown>,
        );
        return NextResponse.json({ jsonrpc: "2.0", id, result });
      }
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not allowed" },
        },
        { status: 403 },
      );
    } catch (error) {
      const denied =
        (error instanceof Error &&
          Object.hasOwn(preEffectDenials, error.message)) ||
        (error instanceof MarketError && error.code === "listing_unavailable");
      const unknown = body.method === "tools/call" && !denied;
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: unknown ? -32004 : -32003,
            message: unknown
              ? "Tool execution outcome is unknown; do not retry automatically"
              : "Session tool unavailable or grant revoked",
            ...(unknown ? { data: { status: "execution_unknown" } } : {}),
          },
        },
        { status: unknown ? 502 : 403 },
      );
    }
  },
);
