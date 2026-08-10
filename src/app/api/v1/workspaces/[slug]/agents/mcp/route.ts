import { NextResponse } from 'next/server';
import { Buffer } from 'node:buffer';
import { resolveAgentControlRequestUser } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { logRequest } from '@/lib/observability/log';
import { isSameOriginRequest } from '@/lib/http/origin';
import {
  AGENT_CONTROL_MCP_TOOLS,
  executeAgentControlTool,
  isAgentControlTool,
} from '@/lib/agents/control-mcp';
import { AgentControlError } from '@/lib/agents/control-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PROTOCOL_VERSION = '2025-06-18';
const LEGACY_STREAMABLE_HTTP_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  PROTOCOL_VERSION,
  LEGACY_STREAMABLE_HTTP_VERSION,
]);
const MAX_REQUEST_BYTES = 256 * 1024;

type RpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    { status },
  );
}

function toolResult(id: unknown, value: unknown) {
  return NextResponse.json({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      structuredContent: { result: value },
    },
  });
}

function toolError(id: unknown, code: string, message: string) {
  const value = { error: { code, message } };
  return NextResponse.json({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: true,
    },
  });
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as RpcRequest;
  return request.jsonrpc === '2.0'
    && typeof request.method === 'string'
    && request.method.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function initializeProtocolVersion(params: unknown): string | null {
  if (!isObject(params)) return null;
  const { protocolVersion, capabilities, clientInfo } = params;
  if (typeof protocolVersion !== 'string' || !protocolVersion) return null;
  if (!isObject(capabilities) || !isObject(clientInfo)) return null;
  if (typeof clientInfo.name !== 'string' || !clientInfo.name) return null;
  if (typeof clientInfo.version !== 'string' || !clientInfo.version) return null;
  return protocolVersion;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const startedAt = Date.now();
  const { slug } = await params;
  // Non-browser MCP clients normally omit Origin. If a browser supplies one,
  // reject cross-origin requests before authenticating or executing tools.
  if (req.headers.get('origin') && !isSameOriginRequest(req)) {
    return rpcError(null, -32003, 'invalid origin', 403);
  }
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return rpcError(null, -32005, 'request body too large', 413);
  }
  const user = await resolveAgentControlRequestUser(req);
  if (!user) return rpcError(null, -32001, 'unauthorized', 401);

  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) return rpcError(null, -32004, 'workspace not found', 404);

  let raw: unknown;
  try {
    const body = await req.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      return rpcError(null, -32005, 'request body too large', 413);
    }
    raw = JSON.parse(body);
  } catch {
    return rpcError(null, -32700, 'parse error', 400);
  }
  if (!isRpcRequest(raw)) return rpcError(null, -32600, 'invalid request', 400);

  const hasId = Object.prototype.hasOwnProperty.call(raw, 'id');
  const { id, method } = raw;
  if (hasId && !isRequestId(id)) return rpcError(null, -32600, 'invalid request id', 400);
  if (raw.params !== undefined && !isObject(raw.params)) {
    return rpcError(hasId ? id : null, -32602, 'params must be an object', 400);
  }
  const rpcParams = raw.params as Record<string, unknown> | undefined;
  if (method !== 'initialize') {
    // Stateless HTTP has no server-side negotiated session. Per MCP backwards
    // compatibility, a missing header is interpreted as 2025-03-26.
    const version = req.headers.get('mcp-protocol-version')
      ?? LEGACY_STREAMABLE_HTTP_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
      return rpcError(hasId ? id : null, -32006, 'unsupported MCP protocol version', 400);
    }
  }
  let toolName = '';
  let response: NextResponse;
  let auditStatus = 200;

  if (method === 'notifications/initialized' || method === 'initialized') {
    return new NextResponse(null, { status: 202 });
  }
  // Do not execute mutating tool notifications: MCP tool calls are requests
  // and must carry an id so the caller can observe whether creation succeeded.
  if (!hasId) return new NextResponse(null, { status: 202 });

  if (method === 'initialize') {
    const requestedVersion = initializeProtocolVersion(raw.params);
    if (!requestedVersion) return rpcError(id, -32602, 'invalid initialize params');
    response = NextResponse.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `ToolPlane Agent Control: ${workspace.name}`, version: '1.0.0' },
        instructions: 'Discover workspace resources, then create and run ToolPlane agents. Use list_agent_resources and list_agents before create_agent.',
      },
    });
  } else if (method === 'ping') {
    response = NextResponse.json({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    response = NextResponse.json({
      jsonrpc: '2.0',
      id,
      result: { tools: AGENT_CONTROL_MCP_TOOLS },
    });
  } else if (method === 'tools/call') {
    toolName = typeof rpcParams?.name === 'string' ? rpcParams.name : '';
    if (!toolName || !isAgentControlTool(toolName)) {
      response = rpcError(id, -32602, `Unknown tool: ${toolName || '(missing)'}`);
      auditStatus = 400;
    } else {
      try {
        const result = await executeAgentControlTool(
          { workspaceId: workspace.id, workspaceSlug: workspace.slug },
          toolName,
          rpcParams?.arguments,
        );
        response = toolResult(id, result);
      } catch (error) {
        if (error instanceof AgentControlError) {
          response = toolError(id, error.code, error.message);
          auditStatus = error.code === 'not_found'
            ? 404
            : error.code === 'unavailable'
              ? 503
              : 400;
        } else {
          response = toolError(id, 'internal_error', 'The Agent Control operation failed.');
          auditStatus = 500;
        }
      }
    }
  } else {
    response = rpcError(id, -32601, `Method not found: ${method}`);
    auditStatus = 404;
  }

  await logRequest({
    workspaceId: workspace.id,
    method: 'POST',
    path: `/workspaces/${slug}/agents/mcp#${method}${toolName ? `:${toolName}` : ''}`,
    // Tool errors stay HTTP 200 per MCP, while observability records their
    // semantic status so failures are visible in workspace error metrics.
    statusCode: auditStatus,
    durationMs: Date.now() - startedAt,
  });
  return response;
}

export function GET(req: Request) {
  if (req.headers.get('origin') && !isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid origin' }, { status: 403 });
  }
  return NextResponse.json(
    { error: 'Use POST for MCP JSON-RPC. Create a personal API token in workspace settings.' },
    { status: 405 },
  );
}
