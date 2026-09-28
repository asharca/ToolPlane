import 'server-only';
import { z } from 'zod';
import { toJsonRpcError } from '@a2a-js/sdk/errors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { agentRuntimeTokenFromRequest } from '@/lib/agents/runtime-access';
import { parseJson } from '@/lib/agents/public-api/body';
import { withLogContext } from '@/lib/observability/context';
import { assertLocalRuntimeToken } from './local-runtime';
import { LOCAL_LIMITS } from './local-policy';
import { Rpc } from './validation';
import { executeLocalMcpTool, localCommunicationCatalog } from './local-mcp-tools';
import { executePiCommunicationTool, piCommunicationCatalog } from './pi-tools';

const requests = new Map<string, { until: number; count: number }>();
function admit(id: string) {
  const now = Date.now();
  if (requests.size >= 4096) for (const [key, value] of requests) if (value.until <= now) requests.delete(key);
  const entry = requests.get(id);
  if (!entry || entry.until <= now) {
    if (requests.size >= 4096 && !entry) return false;
    requests.set(id, { until: now + 60_000, count: 1 }); return true;
  }
  return ++entry.count <= 120;
}
/** MCP is an executor tool bridge, not a renamed or nonstandard A2A network protocol. */
export async function handleLocalMcp(req: Request, taskId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    const headers = { 'cache-control': 'private, no-store' };
    if (req.headers.has('origin')) return Response.json({ error: 'Origin not allowed' }, { status: 403, headers });
    const token = await agentRuntimeTokenFromRequest(req);
    if (!token || token.a2aTaskId !== taskId) return Response.json({ error: 'Invalid task credential' }, { status: 401, headers });
    const authority = await assertLocalRuntimeToken(token).catch(() => null);
    if (!authority) return Response.json({ error: 'Task authority expired' }, { status: 403, headers });
    if (!admit(taskId)) return Response.json({ error: 'Request limit' }, { status: 429, headers: { ...headers, 'retry-after': '60' } });
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return Response.json({ error: 'Expected JSON' }, { status: 415, headers });
    const parsed = await parseJson(req, Rpc, LOCAL_LIMITS.requestBytes);
    if (!parsed.ok) return Response.json({ error: 'Invalid MCP request' }, { status: parsed.reason === 'too_large' ? 413 : 400, headers });
    const credential = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-toolplane-runtime-token');
    if (credential && credential.length > 20 && JSON.stringify(parsed.value).includes(credential)) return Response.json({ error: 'Credentials are not task content' }, { status: 400, headers });
    const native = authority.row.executionBackend === 'pi-harness';
    const enabled = await db.agent.count({ where: { id: authority.grant.agentId, workspaceId: authority.grant.workspaceId,
      OR: [{ a2aInternalEnabled: true }, { subAgents: { some: {} } }] } });
    const tools = enabled ? native ? piCommunicationCatalog : localCommunicationCatalog : [];
    const server = new Server({ name: 'toolplane-native-a2a', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ schema, ...tool }) => ({ ...tool, inputSchema: z.toJSONSchema(schema) as { type: 'object' } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (!tools.some(tool => tool.name === request.params.name)) throw new Error('Unknown collaboration tool');
        const execute = native ? executePiCommunicationTool : executeLocalMcpTool;
        const result = await execute(token, request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      } catch (error) {
        const rpc = toJsonRpcError(error);
        return { content: [{ type: 'text', text: JSON.stringify({ code: rpc.code,
          message: rpc.code === -32603 ? 'Local A2A operation failed.' : rpc.message }) }], isError: true };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: parsed.value });
      response.headers.set('cache-control', 'private, no-store');
      return response;
    } finally { await server.close(); }
  });
}
