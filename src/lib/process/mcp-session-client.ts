import "server-only";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  McpError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { recordEvent } from "@/lib/observability/events";
import {
  elicit,
  sample,
  sessionRoots,
  type McpCallbackContext,
} from "./mcp-callbacks";

/** A tool invocation gets a private MCP client. Its callbacks never see another
 * run's token, working directory, response IDs or model selection. */
export async function callWithCallbacks(
  port: number,
  context: McpCallbackContext,
  method: string,
  params: Record<string, unknown> | undefined,
  timeout: number,
  signal: AbortSignal,
  byteLimit: number,
  tooLarge: () => Error,
) {
  const cap = new AbortController();
  const active = AbortSignal.any([signal, cap.signal]);
  let bytes = 0;
  const remote = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/session`),
    {
      requestInit: { headers: { "x-toolplane-mcp-owner": randomUUID() } },
      fetch: async (input, init) => {
        const cleanup = init?.method === "DELETE";
        const combined = AbortSignal.any([
          cleanup ? AbortSignal.timeout(3000) : active,
          ...(init?.signal ? [init.signal] : []),
        ]);
        const res = await fetch(input, {
          ...init,
          signal: combined,
          redirect: "error",
          cache: "no-store",
        });
        if (!res.body) return res;
        const body = res.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > byteLimit) {
                const error = tooLarge();
                cap.abort(error);
                throw error;
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, res);
      },
    },
  );
  const client = new Client(
    { name: "ToolPlane", version: "1" },
    { capabilities: { sampling: {}, elicitation: { form: {} }, roots: {} } },
  );
  let sampling = 0;
  let callbacks = 0;
  let dispatched = false;
  async function handle<T>(method: string, fn: () => Promise<T>): Promise<T> {
    let reason: string | undefined;
    try {
      active.throwIfAborted();
      if (context.token && context.token.exp * 1000 <= Date.now())
        throw new McpError(-32000, "MCP_GRANT_EXPIRED");
      if (!dispatched && method !== "roots/list")
        throw new McpError(-32601, "MCP_DISCOVERY_CALLBACK_DENIED");
      if (++callbacks > 32) throw new McpError(-32000, "MCP_CALLBACK_LIMIT");
      return await fn();
    } catch (error) {
      // SDK McpError.message includes a numeric prefix. Do not forward arbitrary
      // upstream/provider exception messages across the callback boundary.
      reason =
        error instanceof McpError
          ? /\bMCP_[A-Z_]+$/.exec(error.message)?.[0]
          : undefined;
      reason ??= "MCP_CALLBACK_FAILED";
      throw new McpError(
        error instanceof McpError ? error.code : -32000,
        reason,
      );
    } finally {
      await recordEvent({
        domain: "mcp",
        eventName: "mcp.callback",
        rpcMethod: method,
        workspaceId: context.workspaceId,
        deploymentId: context.deploymentId,
        errorCode: reason,
        outcome: reason ? "error" : "success",
        payloadPolicy: "metadata-only",
      });
    }
  }
  client.setRequestHandler(ListRootsRequestSchema, ({ method }) =>
    handle(method, () => sessionRoots(context)),
  );
  client.setRequestHandler(ElicitRequestSchema, ({ method, params }, extra) =>
    handle(method, () =>
      elicit(context, params, AbortSignal.any([active, extra.signal])),
    ),
  );
  client.setRequestHandler(
    CreateMessageRequestSchema,
    ({ method, params }, extra) =>
      handle(method, async () => {
        if (++sampling > 4) throw new McpError(-32000, "MCP_SAMPLING_LIMIT");
        return sample(context, params, AbortSignal.any([active, extra.signal]));
      }),
  );
  try {
    await client.connect(remote, { signal: active, timeout });
    dispatched =
      method === "tools/call" ||
      method === "resources/read" ||
      method === "prompts/get";
    const result = await client.request({ method, params }, ResultSchema, {
      signal: active,
      timeout,
    });
    return { result, bytes };
  } catch (error) {
    if (cap.signal.aborted) throw cap.signal.reason;
    throw error;
  } finally {
    dispatched = false;
    if (remote.sessionId)
      await remote.terminateSession().catch(() => undefined);
    await client.close();
  }
}
