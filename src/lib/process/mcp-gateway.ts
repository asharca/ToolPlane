import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseJson } from "@/lib/agents/public-api/body";
import { recordEvent } from "@/lib/observability/events";
import {
  filterGatewayReply,
  gatewayDenial,
  gatewayEventStream,
} from "./mcp-message-policy";
import { withLogContext } from "@/lib/observability/context";
import { NextResponse } from "next/server";
import { livePort, liveRedactionValues } from "@/lib/process/supervisor";
import { redactMcpResult } from "./mcp-result-redaction";
import { withCurrentOAuthBridge } from "@/lib/remote-mcp/oauth/live";
import { withDeploymentSandboxAccess } from "./deployment-gateway";
import {
  mcpToolPolicyFromStored,
  type StoredMcpToolPolicy,
} from "@/lib/workspace/mcp-tool-exposure";

export type McpGatewayDeployment = StoredMcpToolPolicy & {
  id: string;
  workspaceId: string;
  toolsOnly?: boolean;
  principalKey?: string;
  timeoutMs?: number;
  oauth?: boolean;
  sandbox?: { id: string } | null;
};

async function proxyRpcRequest(
  req: Request,
  deployment: McpGatewayDeployment,
  checkedPort?: number,
): Promise<Response> {
  const start = Date.now();
  const policy = mcpToolPolicyFromStored(deployment);
  const only = deployment.toolsOnly === true;
  const port = checkedPort ?? livePort(deployment.id);
  const session = req.headers.get("mcp-session-id");
  const version = req.headers.get("mcp-protocol-version");
  const calls = new Map<string | number, string>();
  const deniedReplies: JSONRPCMessage[] = [];
  let rpcMethod: string | undefined;
  let toolName: string | undefined;
  let body: JSONRPCMessage | JSONRPCMessage[] | undefined;
  let terminal: JSONRPCMessage | JSONRPCMessage[] | null = null;
  const secrets = liveRedactionValues(deployment.id) ?? [];
  const log = (status: number, reason?: string, failed = false) =>
    recordEvent({
      workspaceId: deployment.workspaceId,
      deploymentId: deployment.id,
      domain: "mcp",
      eventName: "gateway.request",
      method: req.method,
      path: `/mcp/${deployment.id}/rpc`,
      rpcMethod,
      toolName,
      httpStatus: status,
      errorCode: reason ?? (failed ? "MCP_RPC_ERROR" : undefined),
      durationMs: Date.now() - start,
      outcome: reason || failed || status >= 400 ? "error" : "success",
      secrets,
      payloadPolicy: "diagnostic",
      ...(body && !Array.isArray(body) && "method" in body && terminal
        ? { detail: () => ({ request: body, response: terminal }) }
        : {}),
    });
  const reject = async (
    status: number,
    code: number,
    reason: string,
    id: string | number | null = null,
    message = reason,
  ) => {
    await log(status, reason);
    return Response.json(
      { jsonrpc: "2.0", id, error: { code, message, data: { reason } } },
      { status },
    );
  };
  if (req.method === "POST") {
    const parsed = await parseJson(req, z.unknown(), 1_048_576);
    if (!parsed.ok)
      return reject(
        parsed.reason === "too_large" ? 413 : 400,
        -32700,
        "MCP_INVALID_BODY",
      );
    const batch = Array.isArray(parsed.value);
    if (
      batch &&
      (!session ||
        version !== "2025-03-26" ||
        !(parsed.value as unknown[]).length ||
        (parsed.value as unknown[]).length > 64)
    )
      return reject(400, -32600, "MCP_BATCH_FORBIDDEN");
    const messages: JSONRPCMessage[] = [];
    for (const raw of batch ? (parsed.value as unknown[]) : [parsed.value]) {
      const validation = JSONRPCMessageSchema.safeParse(raw);
      if (!validation.success)
        return reject(400, -32600, "MCP_INVALID_MESSAGE");
      const m = validation.data;
      rpcMethod = "method" in m ? m.method : "response";
      toolName =
        rpcMethod === "tools/call" &&
        "params" in m &&
        typeof m.params?.name === "string"
          ? m.params.name
          : undefined;
      if ("method" in m && "id" in m) {
        if (calls.has(m.id))
          return reject(400, -32600, "MCP_DUPLICATE_REQUEST_ID");
        calls.set(m.id, m.method);
      }
      const denied = gatewayDenial(m, only, policy);
      if (denied) {
        if (!batch && "id" in m)
          return reject(
            200,
            denied.code,
            denied.data.reason,
            m.id ?? null,
            denied.message,
          );
        await log(403, denied.data.reason);
        if ("id" in m)
          deniedReplies.push({ jsonrpc: "2.0", id: m.id, error: denied });
        continue;
      }
      if (only && "method" in m && m.method === "initialize")
        m.params = { ...m.params, capabilities: {} };
      messages.push(m);
    }
    if (!messages.length)
      return deniedReplies.length
        ? Response.json(deniedReplies)
        : new Response(null, { status: 202 });
    body = batch ? messages : messages[0];
    if (batch) rpcMethod = "batch";
  }
  if (!port) return reject(503, -32000, "MCP_DEPLOYMENT_UNAVAILABLE");
  const useSession =
    Boolean(session) ||
    req.method !== "POST" ||
    (rpcMethod === "initialize" &&
      req.headers.get("accept")?.includes("text/event-stream"));
  if (useSession && !deployment.principalKey)
    return reject(403, -32000, "MCP_SESSION_FORBIDDEN");
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  // A retained session is not authority. Bind its upstream connection to the
  // resolved principal and current grant, never to caller-supplied headers.
  headers.set(
    "x-toolplane-mcp-owner",
    createHash("sha256")
      .update(
        JSON.stringify([deployment.id, deployment.principalKey, only, policy]),
      )
      .digest("hex"),
  );
  if (session) headers.set("mcp-session-id", session);
  if (version) headers.set("mcp-protocol-version", version);
  const filter = (message: unknown) => {
    if (secrets.length && message && typeof message === "object") {
      const sanitized = redactMcpResult(
        message as Record<string, unknown>,
        secrets,
      );
      if (!sanitized || JSON.stringify(sanitized) !== JSON.stringify(message))
        throw new Error("MCP_RESULT_REDACTION_REQUIRED");
    }
    return filterGatewayReply(message, calls, only, policy);
  };
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${port}/${useSession ? "session" : ""}`,
      {
        method: req.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([
          req.signal,
          AbortSignal.timeout(deployment.timeoutMs ?? 305_000),
        ]),
      },
    );
    const outHeaders = new Headers({
      "cache-control": "private, no-store, no-transform",
    });
    const sid = upstream.headers.get("mcp-session-id");
    if (sid) outHeaders.set("mcp-session-id", sid);
    if (
      upstream.body &&
      upstream.headers.get("content-type")?.includes("text/event-stream")
    ) {
      outHeaders.set("content-type", "text/event-stream");
      let failed = false;
      const stream = gatewayEventStream(
        upstream.body,
        (m) => {
          const value = filter(m);
          if (value && !("method" in value) && !Array.isArray(body))
            terminal = value;
          if (
            value &&
            ("error" in value ||
              ("result" in value && value.result.isError === true))
          )
            failed = true;
          return value;
        },
        (reason) => {
          void log(upstream.status, reason, failed);
        },
        deniedReplies,
      );
      return new Response(stream, {
        status: upstream.status,
        headers: outHeaders,
      });
    }
    const text = await upstream.text();
    if (!text) {
      await log(upstream.status);
      if (upstream.ok && deniedReplies.length)
        return Response.json(deniedReplies, { headers: outHeaders });
      return new Response(null, {
        status: upstream.status,
        headers: outHeaders,
      });
    }
    const raw = JSON.parse(text);
    if (!upstream.ok)
      return reject(upstream.status, -32000, "MCP_UPSTREAM_REJECTED");
    const result = Array.isArray(raw)
      ? [
          ...deniedReplies,
          ...raw.flatMap((m) => {
            const value = filter(m);
            return value ? [value] : [];
          }),
        ]
      : filter(raw);
    terminal = result;
    const failed = (Array.isArray(result) ? result : [result]).some(
      (m) =>
        m && ("error" in m || ("result" in m && m.result.isError === true)),
    );
    await log(upstream.status, undefined, failed);
    return Response.json(result, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch {
    return reject(
      502,
      -32000,
      req.signal.aborted ? "MCP_REQUEST_CANCELLED" : "MCP_TRANSPORT_FAILED",
    );
  }
}

export function proxyMcpRpcRequest(
  req: Request,
  deployment: McpGatewayDeployment,
): Promise<Response> {
  if (deployment.oauth) {
    return withCurrentOAuthBridge(
      deployment.workspaceId,
      deployment.id,
      (_spec, snapshot) =>
        withLogContext(
          {
            callId: randomUUID(),
            workspaceId: deployment.workspaceId,
            deploymentId: deployment.id,
            secrets: snapshot.redactionValues,
          },
          () => proxyRpcRequest(req, deployment, snapshot.port),
        ),
    ).catch(() =>
      NextResponse.json({ error: "deployment unavailable" }, { status: 503 }),
    );
  }
  return withLogContext(
    {
      callId: randomUUID(),
      workspaceId: deployment.workspaceId,
      deploymentId: deployment.id,
    },
    () =>
      withDeploymentSandboxAccess(deployment.sandbox?.id, () =>
        proxyRpcRequest(req, deployment),
      ),
  );
}
