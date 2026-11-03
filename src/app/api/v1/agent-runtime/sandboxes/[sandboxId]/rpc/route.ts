import { withRequestLogging } from "@/lib/observability/http";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  agentRuntimeTokenFromRequest,
  bindRuntimeLogContext,
} from "@/lib/agents/runtime-access";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { parseJson } from "@/lib/agents/public-api/body";
import {
  callSandboxTool,
  listSandboxTools,
} from "@/lib/sandboxes/tool-dispatch";

export const runtime = "nodejs";
// Sandbox commands are bounded at 120 seconds; the dispatcher waits up to 180.
export const maxDuration = 200;

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

const rpcError = (
  id: string | number | null,
  status: number,
  code: number,
  message: string,
  reason?: string,
) =>
  NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(reason ? { data: { reason } } : {}) },
    },
    { status },
  );

/** Session-scoped access to one sandbox attached to the Agent; never the export gateway. */
export const POST = withRequestLogging(
  "/api/v1/agent-runtime/sandboxes/[sandboxId]/rpc",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ sandboxId: string }> },
  ) {
    const token = await agentRuntimeTokenFromRequest(req);
    if (!token)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { sandboxId } = await params;
    if (!token.externalSandboxIds?.includes(sandboxId))
      return NextResponse.json(
        { error: "sandbox is outside the runtime grant" },
        { status: 403 },
      );
    const grant = await resolveAgentRuntimeGrant(token);
    if (!grant)
      return NextResponse.json(
        { error: "runtime grant is no longer valid" },
        { status: 403 },
      );
    bindRuntimeLogContext(token);
    const parsed = await parseJson(req, runtimeRpc, 4_000_000);
    if (!parsed.ok)
      return NextResponse.json(
        { error: "invalid JSON-RPC request" },
        { status: parsed.reason === "too_large" ? 413 : 400 },
      );
    const body = parsed.value;
    const id = body.id ?? null;
    if (body.method === "initialize")
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ToolPlane external sandbox", version: "1.0.0" },
        },
      });
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "ping")
      return NextResponse.json({ jsonrpc: "2.0", id, result: {} });
    if (body.method !== "tools/list" && body.method !== "tools/call")
      return rpcError(id, 403, -32601, "Method not allowed");

    const allowed = grant.externalSandboxTools[sandboxId];
    const sandbox = allowed
      ? await db.sandbox.findFirst({
          where: { id: sandboxId, workspaceId: token.workspaceId },
          select: {
            id: true,
            workspaceId: true,
            deploymentId: true,
            deployment: {
              select: {
                status: true,
                mcpToolExposure: true,
                mcpAllowedTools: true,
              },
            },
          },
        })
      : null;
    if (body.method === "tools/list") {
      // A detached or stopped sandbox lists nothing instead of aborting the session.
      const tools =
        sandbox && allowed
          ? await listSandboxTools(sandbox, allowed, req.signal).catch(() => [])
          : [];
      return NextResponse.json({ jsonrpc: "2.0", id, result: { tools } });
    }
    if (!sandbox || !allowed)
      return rpcError(
        id,
        403,
        -32003,
        "Sandbox detached or grant revoked",
        "MCP_GRANT_REVOKED",
      );
    const call = z
      .object({
        name: z.string().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(body.params);
    if (!call.success)
      return rpcError(id, 400, -32602, "Invalid tool parameters");
    const result = await callSandboxTool(
      sandbox,
      allowed,
      call.data.name,
      call.data.arguments ?? {},
    );
    return NextResponse.json({ jsonrpc: "2.0", id, result });
  },
);
