import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAgent } from '@/lib/agents/queries';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { verifyHermesRuntimeToken } from '@/lib/agents/hermes/token';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, mcpRpc } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';
import {
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
  loadMcpToolPolicies,
} from '@/lib/workspace/mcp-tool-exposure';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PROTOCOL_VERSION = '2025-06-18';
const SEP = '__';

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

  let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = await req.json() as typeof message;
  } catch {
    return errorResponse(null, -32700, 'parse error', 400);
  }

  const { id, method } = message;
  const rpcParams = message.params ?? {};
  const deploymentIds = resolveAgentTools(agent).deploymentIds;
  const policies = method === 'tools/list' || method === 'tools/call'
    ? await loadMcpToolPolicies(deploymentIds, runtimeRow.workspaceId)
    : new Map();
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
    for (const deploymentId of deploymentIds) {
      const policy = policies.get(deploymentId);
      if (!policy) continue;
      if (liveStatus(deploymentId) !== 'running') continue;
      const listed = filterMcpToolsForAi(
        await listMcpTools(deploymentId),
        policy,
      );
      for (const tool of listed) {
        tools.push({
          name: `${deploymentId}${SEP}${tool.name}`,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    response = NextResponse.json({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const fullName = String(rpcParams.name ?? '');
    const separator = fullName.indexOf(SEP);
    const deploymentId = separator < 0 ? '' : fullName.slice(0, separator);
    const toolName = separator < 0 ? fullName : fullName.slice(separator + SEP.length);
    const args = (rpcParams.arguments as Record<string, unknown>) ?? {};
    logTool = toolName;
    requestBody = JSON.stringify({ name: toolName, arguments: args }).slice(0, 16_000);

    if (!deploymentIds.includes(deploymentId)) {
      response = errorResponse(id, -32602, `Unknown tool: ${fullName}`);
    } else if (!isMcpToolExposedToAi(policies.get(deploymentId), toolName)) {
      response = errorResponse(id, -32602, `Unknown tool: ${fullName}`);
    } else if (liveStatus(deploymentId) !== 'running') {
      logDeploymentId = deploymentId;
      response = errorResponse(id, -32000, 'tool deployment is not running');
    } else {
      logDeploymentId = deploymentId;
      const result = await mcpRpc(deploymentId, 'tools/call', { name: toolName, arguments: args });
      response = result
        ? NextResponse.json({ jsonrpc: '2.0', id, result })
        : errorResponse(id, -32000, 'tool deployment is unreachable');
      responseBody = JSON.stringify(result ?? null).slice(0, 16_000);
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
