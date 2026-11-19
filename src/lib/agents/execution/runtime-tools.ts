import "server-only";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { a2aTransportBodyBytes } from "@/lib/transport-policy";
import { z } from "zod";
import { toJsonRpcError } from "@a2a-js/sdk/errors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/lib/db";
import { agentRuntimeTokenFromRequest } from "@/lib/agents/runtime-access";
import { parseJson } from "@/lib/agents/public-api/body";
import { withLogContext, enrichLogContext } from "@/lib/observability/context";
import {
  recordA2AEvent,
  a2aTaskOutcome,
  taskStateName,
} from "@/lib/observability/a2a-log";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { LOCAL_LIMITS } from "@/lib/a2a/local-policy";
import { Rpc } from "@/lib/a2a/validation";
import {
  piRuntimeCatalog,
  piOptionalPlatformTools,
} from "./runtime-tool-catalog";
import { A2AHttpError } from "@/lib/a2a/principal";
import { requireAgentRevision } from "@/lib/agents/revisions";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { publishLocalArtifact } from "@/lib/a2a/local-artifacts";
import { agentOptionalBuiltinTool } from "../runtime-kind";
import { isWebTool, WebToolError } from "./web-tool-errors";
import { AgentMemoryError } from "../memory-inputs";
import { executeAgentMemoryTool } from "../memories";

/** Trusted platform dispatch; implementations must validate arguments and preserve task authority. */
// Registry-selected optional plugins stay lazy: static loading initializes the session-MCP
// search subsystem for artifact-only task requests, which do not require it.
export const optionalBuiltinPlatformHandlers: Readonly<
  Record<
    string,
    (
      token: AgentRuntimeTokenPayload,
      raw: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>
  >
> = {
  web_search: async (token, raw, signal) => {
    const { executeWebTool } = await import("./web-tools");
    return executeWebTool(token, "web_search", raw, signal);
  },
  web_fetch: async (token, raw, signal) => {
    const { executeWebTool } = await import("./web-tools");
    return executeWebTool(token, "web_fetch", raw, signal);
  },
  memory_retain: (token, raw, signal) =>
    executeAgentMemoryTool(token, "memory_retain", raw, signal),
  memory_recall: (token, raw, signal) =>
    executeAgentMemoryTool(token, "memory_recall", raw, signal),
  memory_forget: (token, raw, signal) =>
    executeAgentMemoryTool(token, "memory_forget", raw, signal),
};

const optionalBuiltinDeniedMessage = "Optional built-in tool is not enabled.";

const requests = new Map<string, { until: number; count: number }>();
function admit(id: string) {
  const now = Date.now();
  if (requests.size >= 4096)
    for (const [key, value] of requests)
      if (value.until <= now) requests.delete(key);
  const entry = requests.get(id);
  if (!entry || entry.until <= now) {
    if (requests.size >= 4096 && !entry) return false;
    requests.set(id, { until: now + 60_000, count: 1 });
    return true;
  }
  return ++entry.count <= 120;
}
/** Task tools are shared execution capabilities; A2A is an optional adapter. */
export async function handleRuntimeTools(req: Request, taskId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    const headers = { "cache-control": "private, no-store" };
    if (req.headers.has("origin"))
      return Response.json(
        { error: "Origin not allowed" },
        { status: 403, headers },
      );
    const token = await agentRuntimeTokenFromRequest(req);
    if (!token || token.a2aTaskId !== taskId)
      return Response.json(
        { error: "Invalid task credential" },
        { status: 401, headers },
      );
    const authority = await assertLocalRuntimeToken(token).catch(() => null);
    if (!authority)
      return Response.json(
        { error: "Task authority expired" },
        { status: 403, headers },
      );
    enrichLogContext({
      taskId: authority.row.id,
      workspaceId: authority.grant.workspaceId,
      agentId: authority.grant.agentId,
      conversationId:
        token.conversationId ?? authority.grant.entryPolicy?.conversationId,
    });
    if (!admit(taskId))
      return Response.json(
        { error: "Request limit" },
        { status: 429, headers: { ...headers, "retry-after": "60" } },
      );
    if (
      req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return Response.json(
        { error: "Expected JSON" },
        { status: 415, headers },
      );
    const parsed = await parseJson(
      req,
      Rpc,
      Math.max(
        LOCAL_LIMITS.requestBytes,
        a2aTransportBodyBytes(await getTransportSettings()),
      ),
    );
    if (!parsed.ok)
      return Response.json(
        { error: "Invalid MCP request" },
        { status: parsed.reason === "too_large" ? 413 : 400, headers },
      );
    const credential =
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      req.headers.get("x-toolplane-runtime-token");
    if (
      credential &&
      credential.length > 20 &&
      JSON.stringify(parsed.value).includes(credential)
    )
      return Response.json(
        { error: "Credentials are not task content" },
        { status: 400, headers },
      );
    if (authority.row.executionBackend !== "pi-sdk")
      return Response.json(
        { error: "Retired local execution is read-only." },
        { status: 410, headers },
      );
    const revision = await requireAgentRevision(
      db,
      authority.grant.agentId,
      authority.grant.agentRevisionId,
    );
    // Catalog positions participate in immutable native tool names. Revocation
    // narrows calls, never renumbers the pinned revision's remaining tools.
    const tools = piRuntimeCatalog(
      revision.config.a2a.outboundEnabled,
      revision.config.optionalBuiltinTools,
    );
    const server = new Server(
      { name: "toolplane-agent-runtime", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ schema, ...tool }) => ({
        ...tool,
        inputSchema: z.toJSONSchema(schema) as { type: "object" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const started = performance.now();
      const known = tools.some((tool) => tool.name === request.params.name);
      const toolName = known ? request.params.name : "unknown";
      const args = request.params.arguments ?? {};
      // Rejected retention input can itself contain a credential. Never log
      // memory payloads (including recall output) into observability storage.
      const memoryTool = [
        "memory_retain",
        "memory_recall",
        "memory_forget",
      ].includes(toolName);
      const { row, grant } = authority;
      const binding = known
        ? {
            grant,
            taskId: row.id,
            contextId: row.contextId,
            rootTaskId: row.rootTaskId ?? row.id,
            parentTaskId: row.parentTaskId ?? undefined,
          }
        : undefined;
      try {
        if (!known && agentOptionalBuiltinTool(request.params.name))
          throw new A2AHttpError(403, "OPTIONAL_BUILTIN_DISABLED");
        if (!known) throw new Error("Unknown runtime tool");
        const result = await executeRuntimeTool(
          token,
          request.params.name,
          args,
          req.signal,
        );
        const response = {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: false,
        };
        const task =
          result && typeof result === "object" && "task" in result
            ? result.task
            : undefined;
        const status =
          task && typeof task === "object" && "status" in task
            ? task.status
            : undefined;
        const state =
          status &&
          typeof status === "object" &&
          "state" in status &&
          typeof status.state === "string"
            ? status.state
            : undefined;
        const taskState = state ? taskStateName(state) : undefined;
        await recordA2AEvent({
          eventName: "a2a.request",
          binding,
          metadata: { direction: "internal", transport: "mcp", taskState },
          rpcMethod: "tools/call",
          toolName,
          outcome: a2aTaskOutcome(state),
          durationMs: performance.now() - started,
          ...(!isWebTool(request.params.name) && !memoryTool
            ? { request: args, response }
            : {}),
          responseKind: "json",
          responseComplete: true,
          secrets: credential ? [credential] : undefined,
        });
        return response;
      } catch (error) {
        const rpc = toJsonRpcError(error);
        const optionalDenied =
          error instanceof A2AHttpError &&
          error.status === 403 &&
          error.code === "OPTIONAL_BUILTIN_DISABLED";
        const webFailure = error instanceof WebToolError ? error : undefined;
        const memoryError = error instanceof AgentMemoryError ? error : null;
        const response = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: rpc.code,
                message: webFailure
                  ? webFailure.message
                  : memoryError
                    ? memoryError.message
                    : optionalDenied
                      ? optionalBuiltinDeniedMessage
                      : rpc.code === -32603
                        ? "Agent runtime tool operation failed."
                        : rpc.message,
                ...(webFailure
                  ? { reason: webFailure.reason }
                  : memoryError
                    ? { reason: memoryError.reason }
                    : optionalDenied
                      ? { reason: "OPTIONAL_BUILTIN_TOOL_FORBIDDEN" }
                      : {}),
              }),
            },
          ],
          isError: true,
        };
        const denied =
          error instanceof A2AHttpError &&
          (error.status === 401 || error.status === 403);
        await recordA2AEvent({
          eventName: "a2a.request",
          binding,
          metadata: {
            direction: "internal",
            transport: "mcp",
            rpcErrorCode: rpc.code,
          },
          rpcMethod: "tools/call",
          toolName,
          outcome: denied ? "denied" : "error",
          durationMs: performance.now() - started,
          ...(!denied && known && !isWebTool(request.params.name) && !memoryTool
            ? { request: args, response }
            : {}),
          responseKind: "json",
          responseComplete: true,
          secrets: credential ? [credential] : undefined,
        });
        return response;
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(req, {
        parsedBody: parsed.value,
      });
      response.headers.set("cache-control", "private, no-store");
      return response;
    } finally {
      await server.close();
    }
  });
}

async function executeRuntimeTool(
  token: AgentRuntimeTokenPayload,
  name: string,
  raw: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  // Recheck the execution lease after MCP admission and before dispatch.
  const { row, grant } = await assertLocalRuntimeToken(token);
  if (!row.leaseToken) throw new Error("Runtime task lease unavailable.");
  const optional = agentOptionalBuiltinTool(name);
  if (optional) {
    const revision = await requireAgentRevision(
      db,
      grant.agentId,
      grant.agentRevisionId,
    );
    const live = await db.agent.findFirst({
      where: {
        id: grant.agentId,
        workspaceId: grant.workspaceId,
        retiredAt: null,
      },
      select: { optionalBuiltinTools: true },
    });
    if (
      optional.implementation !== "platform" ||
      !(revision.config.optionalBuiltinTools ?? []).includes(name) ||
      !live?.optionalBuiltinTools.includes(name)
    )
      throw new A2AHttpError(403, "OPTIONAL_BUILTIN_DISABLED");
    const handler = optionalBuiltinPlatformHandlers[name];
    if (!handler)
      throw new Error("Optional built-in tool implementation unavailable.");
    const definition = piOptionalPlatformTools.find(
      (tool) => tool.name === name,
    );
    if (!definition)
      throw new Error("Optional built-in tool definition unavailable.");
    const parsed = definition.schema.safeParse(raw);
    if (!parsed.success) {
      if (isWebTool(name)) throw new WebToolError("WEB_TOOL_INVALID_ARGUMENTS");
      throw parsed.error;
    }
    return handler(token, parsed.data, signal);
  }
  if (name === "a2a_publish_artifact")
    return publishLocalArtifact(row.id, row.leaseToken, raw);
  if (
    !(await db.agent.count({
      where: {
        id: grant.agentId,
        workspaceId: grant.workspaceId,
        a2aOutboundEnabled: true,
      },
    }))
  )
    throw new A2AHttpError(403, "COMMUNICATION_DISABLED");
  // Static loading initializes collaboration dispatch/worker dependencies even
  // for artifact-only channel execution; load that optional adapter on use.
  const { executePiCommunicationTool } = await import("@/lib/a2a/pi-tools");
  return executePiCommunicationTool(token, name, raw, signal);
}
