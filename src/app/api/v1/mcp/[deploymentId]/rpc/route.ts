import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { livePort } from '@/lib/process/supervisor';
import { logRequest } from '@/lib/observability/log';
import {
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
  mcpToolPolicyFromStored,
} from '@/lib/workspace/mcp-tool-exposure';

// Gateway: proxy a real MCP JSON-RPC request to the live deployment process
// and record it for observability. POST a JSON-RPC 2.0 envelope, e.g.
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const start = Date.now();
  const { deploymentId } = await params;

  const user = await resolveRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      mcpToolExposure: true,
      mcpAllowedTools: true,
    },
  });
  if (!dep) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = await req.text();
  let rpcMethod = '';
  let toolName = '';
  let rpcId: unknown = null;
  let isBatch = false;
  try {
    const parsed = JSON.parse(body || '{}');
    isBatch = Array.isArray(parsed);
    if (isBatch) {
      rpcMethod = 'batch';
    } else {
      rpcId = parsed?.id ?? null;
      rpcMethod = String(parsed?.method ?? '');
      if (rpcMethod === 'tools/call') toolName = String(parsed?.params?.name ?? '');
    }
  } catch {
    // logged path falls back to the bare rpc path
  }

  const port = livePort(deploymentId);
  let statusCode = 200;
  let payload: unknown = { error: 'deployment not running' };
  const policy = mcpToolPolicyFromStored(dep);

  if (isBatch) {
    statusCode = 400;
    payload = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'JSON-RPC batch requests are not supported.' },
    };
  } else if (rpcMethod === 'tools/call' && !isMcpToolExposedToAi(policy, toolName)) {
    payload = {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32602, message: `Unknown tool: ${toolName}` },
    };
  } else if (!port) {
    statusCode = 503;
  } else {
    try {
      const upstream = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body || '{}',
        signal: AbortSignal.timeout(30000),
      });
      statusCode = upstream.status;
      const text = await upstream.text();
      payload = text ? JSON.parse(text) : {};
      if (rpcMethod === 'tools/list' && payload && typeof payload === 'object') {
        const result = (payload as { result?: unknown }).result;
        if (result && typeof result === 'object') {
          const tools = (result as { tools?: unknown }).tools;
          if (Array.isArray(tools)) {
            payload = {
              ...payload,
              result: {
                ...result,
                tools: filterMcpToolsForAi(
                  tools.filter((tool): tool is { name: string } => (
                    Boolean(tool)
                    && typeof tool === 'object'
                    && typeof (tool as { name?: unknown }).name === 'string'
                  )),
                  policy,
                ),
              },
            };
          }
        }
      }
    } catch {
      statusCode = 502;
      payload = { error: 'upstream unreachable' };
    }
  }

  await logRequest({
    workspaceId: dep.workspaceId,
    deploymentId,
    method: 'POST',
    path: `/mcp/${deploymentId}/rpc${rpcMethod ? `#${rpcMethod}${toolName ? `:${toolName}` : ''}` : ''}`,
    statusCode,
    durationMs: Date.now() - start,
    requestBody: (body || '').slice(0, 16000) || null,
    responseBody: JSON.stringify(payload).slice(0, 16000),
  });

  return NextResponse.json(payload, { status: statusCode });
}
