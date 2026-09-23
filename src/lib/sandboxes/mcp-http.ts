import 'server-only';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listMcpTools, mcpRpc } from '@/lib/process/mcp-client';
import { effectiveStatus } from '@/lib/process/supervisor';
import { enrichLogContext, withLogContext } from '@/lib/observability/context';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';
import { isMcpToolExposedToAi, mcpToolPolicyFromStored } from '@/lib/workspace/mcp-tool-exposure';
import { resolveSandboxMcpGrant, sandboxBearer } from './mcp-access';
import { isSandboxMcpTool } from './mcp-policy';
import { sandboxAuthChallenge, sandboxToolAnnotations, toolOAuthScope } from './oauth-policy';
import { privateJson, readSandboxJson, RequestBodyError } from './http-body';

const counters = new Map<string, { until: number; count: number }>();
function admit(id: string) {
  const now = Date.now();
  if (counters.size >= 4096) for (const [key, value] of counters) if (value.until <= now) counters.delete(key);
  const entry = counters.get(id);
  if (!entry || entry.until <= now) {
    if (counters.size >= 4096 && !entry) return false;
    counters.set(id, { until: now + 60_000, count: 1 }); return true;
  }
  return ++entry.count <= 120;
}
const toolError = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

// Machine-to-machine, stateless Streamable HTTP. This is NOT an arbitrary
// reverse proxy to the sandbox's terminal, private runtime or dashboard routes.
export function handleSandboxMcp(req: Request, sandboxId: string): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    if (req.headers.has('origin')) return privateJson({ error: 'Browser origins are not supported.' }, 403);
    const token = sandboxBearer(req);
    const initial = token && await resolveSandboxMcpGrant(sandboxId, token);
    if (!initial) {
      const response = privateJson({ error: 'Invalid sandbox credential.' }, 401);
      try { response.headers.set('www-authenticate', sandboxAuthChallenge(sandboxId)); }
      catch { return privateJson({ error: 'Configure a canonical HTTPS ToolPlane URL for MCP OAuth.' }, 503); }
      return response;
    }
    enrichLogContext({ actorId: initial.userId, workspaceId: initial.sandbox.workspaceId, deploymentId: initial.sandbox.deploymentId });
    if (req.method !== 'POST') {
      const response = privateJson({ error: 'This stateless endpoint accepts POST only.' }, 405);
      response.headers.set('allow', 'POST'); return response;
    }
    if (!admit(initial.id)) {
      const response = privateJson({ error: 'Request limit exceeded.' }, 429);
      response.headers.set('retry-after', '60'); return response;
    }
    let body: unknown;
    try { body = await readSandboxJson(req, 4_000_000); }
    catch (error) { return privateJson({ error: 'Invalid MCP request.' }, error instanceof RequestBodyError ? error.status : 400); }
    const server = new Server({ name: 'toolplane-sandbox', version: '1.0.0' }, { capabilities: { tools: {} },
      instructions: 'Use only the authorized sandbox. Inspect sandbox_info before work. Commands run with sandbox account permissions. Never retry mutations blindly after a timeout; inspect state first.' });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const grant = await resolveSandboxMcpGrant(sandboxId, token!);
      if (!grant) return { tools: [] };
      if (effectiveStatus(grant.sandbox.deploymentId, grant.sandbox.deployment.status) !== 'running') return { tools: [] };
      const policy = mcpToolPolicyFromStored(grant.sandbox.deployment);
      const tools = await listMcpTools(grant.sandbox.deploymentId, { signal: req.signal });
      return { tools: tools.filter((tool) => isSandboxMcpTool(tool.name)
        && grant.allowedTools.includes(tool.name) && isMcpToolExposedToAi(policy, tool.name)).map((tool) => ({
          ...tool, annotations: sandboxToolAnnotations(tool.name),
          securitySchemes: [{ type: 'oauth2', scopes: [toolOAuthScope(tool.name)] }],
          _meta: { ...tool._meta, securitySchemes: [{ type: 'oauth2', scopes: [toolOAuthScope(tool.name)] }] },
        })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Recheck revocation, expiry, issuer membership and the deployment policy
      // at the point of execution. A handshake grants no permanent authority.
      const grant = await resolveSandboxMcpGrant(sandboxId, token!);
      const name = request.params.name;
      if (!grant || !isSandboxMcpTool(name) || !grant.allowedTools.includes(name)
        || !isMcpToolExposedToAi(mcpToolPolicyFromStored(grant.sandbox.deployment), name)) {
        return toolError('Tool not authorized.');
      }
      if (effectiveStatus(grant.sandbox.deploymentId, grant.sandbox.deployment.status) !== 'running') {
        return toolError('Sandbox is stopped, unavailable or under maintenance. No command was submitted.');
      }
      const release = beginWorkspaceOperation(grant.sandbox.workspaceId);
      if (!release) return toolError('Workspace is unavailable.');
      try {
        return await withSandboxExecutionLease(sandboxId, async () => {
          // Never automatically retry shell/file mutations after a lost reply.
          // The underlying runtime bounds commands to 120 seconds; leave room
          // for its cleanup instead of cutting the public request at 30 seconds.
          const result = await mcpRpc(grant.sandbox.deploymentId, 'tools/call', {
            name, arguments: request.params.arguments ?? {},
          }, 180_000, { maxRequestBytes: 4_000_000, maxResponseBytes: 8_000_000 });
          const parsed = CallToolResultSchema.safeParse(result);
          return parsed.success ? parsed.data : toolError('Sandbox reply unavailable. The command may have executed; inspect state before retrying.');
        });
      } catch { return toolError('Sandbox is busy or unavailable.'); }
      finally { release(); }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: body });
      response.headers.set('cache-control', 'private, no-store'); return response;
    } finally { await server.close(); }
  });
}
