import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAgent } from '@/lib/agents/queries';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { verifyHermesRuntimeToken } from '@/lib/agents/hermes/token';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, McpPayloadTooLargeError, mcpRpc } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';
import {
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
  loadMcpToolPolicies,
} from '@/lib/workspace/mcp-tool-exposure';
import {
  endpointAllowsTool,
  intersectEndpointTools,
  isAgentEndpointRuntimeSandboxConfig,
  parseAgentEndpointToolPolicy,
} from '@/lib/agents/public-api/tool-policy';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PROTOCOL_VERSION = '2025-06-18';
const SEP = '__';
const PUBLIC_MCP_REQUEST_BYTES = 256 * 1024;
const PUBLIC_MCP_RESPONSE_BYTES = 512 * 1024;

async function readJsonRpcRequest(req: Request, maxBytes?: number): Promise<unknown> {
  if (!maxBytes) return req.json();
  const announced = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(announced) && announced > maxBytes) throw new McpPayloadTooLargeError();
  if (!req.body) return null;
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('public MCP request byte limit exceeded').catch(() => undefined);
        throw new McpPayloadTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

function errorResponse(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    { status },
  );
}

function bearerToken(req: Request): string {
  return /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')?.[1] ?? '';
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runtimeId: string }> },
) {
  const startedAt = Date.now();
  const { runtimeId } = await params;
  const runtimeRow = await db.agentRuntime.findUnique({
    where: { id: runtimeId },
    select: { id: true, kind: true, workspaceId: true, agentId: true },
  });
  if (
    !runtimeRow
    || runtimeRow.kind !== 'hermes'
    || !verifyHermesRuntimeToken(runtimeId, 'toolplane-mcp', bearerToken(req))
  ) {
    return errorResponse(null, -32001, 'unauthorized', 401);
  }

  const agent = await getAgent(runtimeRow.workspaceId, runtimeRow.agentId);
  if (!agent?.runtime || agent.runtime.id !== runtimeId) {
    return errorResponse(null, -32004, 'agent runtime not found', 404);
  }
  const publicAllocation = agent.publicRuntimeAllocation;
  if (
    isAgentEndpointRuntimeSandboxConfig(agent.runtime.sandbox.config)
    && !publicAllocation
  ) {
    // An Endpoint deletion can remove the allocation before asynchronous
    // runtime garbage collection. Never let that orphan fall back to the
    // ordinary, broader Agent MCP policy while its container drains.
    return errorResponse(null, -32004, 'agent runtime not found', 404);
  }

  let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = await readJsonRpcRequest(
      req,
      publicAllocation ? PUBLIC_MCP_REQUEST_BYTES : undefined,
    ) as typeof message;
  } catch (error) {
    if (error instanceof McpPayloadTooLargeError) {
      return errorResponse(null, -32002, 'public MCP request is too large', 413);
    }
    return errorResponse(null, -32700, 'parse error', 400);
  }

  const { id, method } = message;
  const rpcParams = message.params ?? {};
  const revisionDeploymentIds = publicAllocation
    ? new Set(publicAllocation.revision.deploymentIds)
    : null;
  const endpointToolPolicy = publicAllocation
    ? parseAgentEndpointToolPolicy(publicAllocation.revision.toolPolicy)
    : null;
  // The hidden Agent is structurally populated from the revision, and this
  // second intersection prevents a stale or manually-added AgentServer link
  // from broadening the public runtime after publication.
  let deploymentIds = resolveAgentTools(agent).deploymentIds.filter((deploymentId) => (
    !revisionDeploymentIds || revisionDeploymentIds.has(deploymentId)
  ));
  const policies = method === 'tools/list' || method === 'tools/call'
    ? await loadMcpToolPolicies(deploymentIds, runtimeRow.workspaceId)
    : new Map();
  if (publicAllocation) {
    deploymentIds = deploymentIds.filter((deploymentId) => (
      policies.get(deploymentId)?.publicInvocable === true
    ));
  }
  let logDeploymentId: string | null = null;
  let logTool = '';
  let requestBody: string | null = null;
  let responseBody: string | null = null;
  let response: NextResponse;

  if (method === 'initialize') {
    response = NextResponse.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `ToolPlane: ${agent.name}`, version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized' || method === 'initialized') {
    return new NextResponse(null, { status: 202 });
  } else if (method === 'ping') {
    response = NextResponse.json({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    const tools: unknown[] = [];
    try {
      for (const deploymentId of deploymentIds) {
        const policy = policies.get(deploymentId);
        if (!policy) continue;
        if (liveStatus(deploymentId) !== 'running') continue;
        const listed = filterMcpToolsForAi(
          await listMcpTools(deploymentId, publicAllocation ? {
            signal: req.signal,
            maxResponseBytes: PUBLIC_MCP_RESPONSE_BYTES,
          } : undefined),
          policy,
        );
        const endpointListed = publicAllocation
          ? intersectEndpointTools(listed, endpointToolPolicy, deploymentId)
          : listed;
        for (const tool of endpointListed) {
          tools.push({
            name: `${deploymentId}${SEP}${tool.name}`,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          });
        }
      }
    } catch (error) {
      if (error instanceof McpPayloadTooLargeError) {
        response = errorResponse(id, -32002, 'public MCP tool catalog is too large', 502);
        await logRequest({
          workspaceId: runtimeRow.workspaceId,
          deploymentId: null,
          method: 'POST',
          path: `/agent-runtimes/${runtimeId}/mcp#tools/list`,
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
          requestBody: null,
          responseBody: null,
        });
        return response;
      }
      throw error;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result: { tools } });
    response = publicAllocation && new TextEncoder().encode(payload).byteLength > PUBLIC_MCP_RESPONSE_BYTES
      ? errorResponse(id, -32002, 'public MCP tool catalog is too large', 502)
      : new NextResponse(payload, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  } else if (method === 'tools/call') {
    const fullName = String(rpcParams.name ?? '');
    const separator = fullName.indexOf(SEP);
    const deploymentId = separator < 0 ? '' : fullName.slice(0, separator);
    const toolName = separator < 0 ? fullName : fullName.slice(separator + SEP.length);
    const args = (rpcParams.arguments as Record<string, unknown>) ?? {};
    const safeLogTool = toolName.replace(/[^a-z0-9_.:-]+/gi, '_').slice(0, 200);
    if (!publicAllocation) logTool = safeLogTool;
    if (!publicAllocation) {
      requestBody = JSON.stringify({ name: toolName, arguments: args }).slice(0, 16_000);
    }

    if (!deploymentIds.includes(deploymentId)) {
      response = errorResponse(id, -32602, `Unknown tool: ${fullName}`);
    } else if (!isMcpToolExposedToAi(policies.get(deploymentId), toolName)) {
      response = errorResponse(id, -32602, `Unknown tool: ${fullName}`);
    } else if (
      publicAllocation
      && !endpointAllowsTool(endpointToolPolicy, deploymentId, toolName)
    ) {
      response = errorResponse(id, -32602, `Unknown tool: ${fullName}`);
    } else if (liveStatus(deploymentId) !== 'running') {
      logDeploymentId = deploymentId;
      response = errorResponse(id, -32000, 'tool deployment is not running');
    } else {
      logDeploymentId = deploymentId;
      logTool = safeLogTool;
      try {
        const result = await mcpRpc(
          deploymentId,
          'tools/call',
          { name: toolName, arguments: args },
          30_000,
          publicAllocation ? {
            signal: req.signal,
            maxRequestBytes: PUBLIC_MCP_REQUEST_BYTES,
            maxResponseBytes: PUBLIC_MCP_RESPONSE_BYTES,
          } : undefined,
        );
        response = result
          ? NextResponse.json({ jsonrpc: '2.0', id, result })
          : errorResponse(id, -32000, 'tool deployment is unreachable');
        if (!publicAllocation) {
          responseBody = JSON.stringify(result ?? null).slice(0, 16_000);
        }
      } catch (error) {
        response = error instanceof McpPayloadTooLargeError
          ? errorResponse(id, -32002, 'public MCP tool payload is too large', 502)
          : errorResponse(id, -32000, 'tool deployment is unreachable');
      }
    }
  } else if (id === undefined || id === null) {
    return new NextResponse(null, { status: 202 });
  } else {
    response = errorResponse(id, -32601, `Method not found: ${method ?? ''}`);
  }

  await logRequest({
    workspaceId: runtimeRow.workspaceId,
    deploymentId: logDeploymentId,
    method: 'POST',
    path: `/agent-runtimes/${runtimeId}/mcp${method ? `#${method}` : ''}${logTool ? `:${logTool}` : ''}`,
    statusCode: response.status,
    durationMs: Date.now() - startedAt,
    requestBody,
    responseBody,
  });
  return response;
}

export function GET() {
  return NextResponse.json({ error: 'Use POST for MCP JSON-RPC.' }, { status: 405 });
}
