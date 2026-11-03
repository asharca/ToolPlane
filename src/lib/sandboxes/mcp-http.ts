import "server-only";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { enrichLogContext, withLogContext } from "@/lib/observability/context";
import { resolveSandboxMcpGrant, sandboxBearer } from "./mcp-access";
import {
  sandboxAuthChallenge,
  sandboxToolAnnotations,
  toolOAuthScope,
} from "./oauth-policy";
import { privateJson, readSandboxJson, RequestBodyError } from "./http-body";
import {
  callSandboxTool,
  listSandboxTools,
  sandboxToolError,
} from "./tool-dispatch";

const counters = new Map<string, { until: number; count: number }>();
function admit(id: string) {
  const now = Date.now();
  if (counters.size >= 4096)
    for (const [key, value] of counters)
      if (value.until <= now) counters.delete(key);
  const entry = counters.get(id);
  if (!entry || entry.until <= now) {
    if (counters.size >= 4096 && !entry) return false;
    counters.set(id, { until: now + 60_000, count: 1 });
    return true;
  }
  return ++entry.count <= 120;
}

// Machine-to-machine, stateless Streamable HTTP. This is NOT an arbitrary
// reverse proxy to the sandbox's terminal, private runtime or dashboard routes.
export function handleSandboxMcp(
  req: Request,
  sandboxId: string,
): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    if (req.headers.has("origin"))
      return privateJson({ error: "Browser origins are not supported." }, 403);
    const token = sandboxBearer(req);
    const initial = token && (await resolveSandboxMcpGrant(sandboxId, token));
    if (!token || !initial) {
      const response = privateJson(
        { error: "Invalid sandbox credential." },
        401,
      );
      try {
        response.headers.set(
          "www-authenticate",
          sandboxAuthChallenge(sandboxId),
        );
      } catch {
        return privateJson(
          { error: "Configure a canonical HTTPS ToolPlane URL for MCP OAuth." },
          503,
        );
      }
      return response;
    }
    enrichLogContext({
      actorId: initial.userId,
      workspaceId: initial.sandbox.workspaceId,
      deploymentId: initial.sandbox.deploymentId,
    });
    if (req.method !== "POST") {
      const response = privateJson(
        { error: "This stateless endpoint accepts POST only." },
        405,
      );
      response.headers.set("allow", "POST");
      return response;
    }
    if (!admit(initial.id)) {
      const response = privateJson({ error: "Request limit exceeded." }, 429);
      response.headers.set("retry-after", "60");
      return response;
    }
    let body: unknown;
    try {
      body = await readSandboxJson(req, 4_000_000);
    } catch (error) {
      return privateJson(
        { error: "Invalid MCP request." },
        error instanceof RequestBodyError ? error.status : 400,
      );
    }
    const server = new Server(
      { name: "toolplane-sandbox", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Use only the authorized sandbox. Inspect sandbox_info before work. Commands run with sandbox account permissions. Never retry mutations blindly after a timeout; inspect state first.",
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const grant = await resolveSandboxMcpGrant(sandboxId, token);
      if (!grant) return { tools: [] };
      const tools = await listSandboxTools(
        grant.sandbox,
        grant.allowedTools,
        req.signal,
      );
      return {
        tools: tools.map((tool) => ({
          ...tool,
          annotations: sandboxToolAnnotations(tool.name),
          securitySchemes: [
            { type: "oauth2", scopes: [toolOAuthScope(tool.name)] },
          ],
          // Export authorization metadata is owned by the gateway, not the
          // upstream runtime. McpToolDefinition deliberately exposes no _meta.
          _meta: {
            securitySchemes: [
              { type: "oauth2", scopes: [toolOAuthScope(tool.name)] },
            ],
          },
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Recheck revocation, expiry, issuer membership and the deployment policy
      // at the point of execution. A handshake grants no permanent authority.
      const grant = await resolveSandboxMcpGrant(sandboxId, token);
      if (!grant) return sandboxToolError("Tool not authorized.");
      return callSandboxTool(
        grant.sandbox,
        grant.allowedTools,
        request.params.name,
        request.params.arguments ?? {},
      );
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: body });
      response.headers.set("cache-control", "private, no-store");
      return response;
    } finally {
      await server.close();
    }
  });
}
