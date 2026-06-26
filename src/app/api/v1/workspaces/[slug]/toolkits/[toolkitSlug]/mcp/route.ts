import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, mcpRpc } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PROTOCOL_VERSION = '2025-06-18';

// A toolkit is exposed as a SINGLE MCP server over the Streamable HTTP transport
// (POST JSON-RPC). tools/list aggregates the tools of every running deployment in
// the toolkit; each tool is namespaced `<deploymentId>__<toolName>` so tools/call
// can be routed back to the right deployment without server-side state.
const SEP = '__';

function err(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; toolkitSlug: string }> },
) {
  const start = Date.now();
  const { slug, toolkitSlug } = await params;

  const user = await resolveRequestUser(req);
  if (!user) return err(null, -32001, 'unauthorized', 401);

  const toolkit = await db.toolkit.findFirst({
    where: {
      slug: toolkitSlug,
      workspace: {
        slug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: {
      name: true,
      workspaceId: true,
      servers: { select: { deploymentId: true } },
    },
  });
  if (!toolkit) return err(null, -32004, 'toolkit not found', 404);

  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = (await req.json()) as typeof msg;
  } catch {
    return err(null, -32700, 'parse error', 400);
  }

  const { id, method } = msg;
  const rpcParams = msg.params ?? {};
  const deploymentIds = toolkit.servers.map((s) => s.deploymentId);

  let response: NextResponse;
  if (method === 'initialize') {
    response = NextResponse.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: toolkit.name, version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized' || method === 'initialized') {
    return new NextResponse(null, { status: 202 });
  } else if (method === 'ping') {
    response = NextResponse.json({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    const tools: unknown[] = [];
    for (const depId of deploymentIds) {
      if (liveStatus(depId) !== 'running') continue;
      const list = await listMcpTools(depId);
      for (const t of list) {
        tools.push({
          name: `${depId}${SEP}${t.name}`,
          description: t.description ?? t.name,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    response = NextResponse.json({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const fullName = String(rpcParams.name ?? '');
    const sep = fullName.indexOf(SEP);
    const depId = sep === -1 ? '' : fullName.slice(0, sep);
    const toolName = sep === -1 ? fullName : fullName.slice(sep + SEP.length);
    if (!deploymentIds.includes(depId)) {
      response = err(id, -32602, `Unknown tool: ${fullName}`);
    } else if (liveStatus(depId) !== 'running') {
      response = err(id, -32000, 'tool deployment is not running');
    } else {
      const result = await mcpRpc(depId, 'tools/call', {
        name: toolName,
        arguments: (rpcParams.arguments as Record<string, unknown>) ?? {},
      });
      response = result
        ? NextResponse.json({ jsonrpc: '2.0', id, result })
        : err(id, -32000, 'tool deployment is unreachable');
    }
  } else if (id === undefined || id === null) {
    return new NextResponse(null, { status: 202 });
  } else {
    response = err(id, -32601, `Method not found: ${method ?? ''}`);
  }

  await logRequest({
    workspaceId: toolkit.workspaceId,
    method: 'POST',
    path: `/workspaces/${slug}/toolkits/${toolkitSlug}/mcp${method ? `#${method}` : ''}`,
    statusCode: 200,
    durationMs: Date.now() - start,
  });

  return response;
}

// The Streamable HTTP transport may GET for a server→client SSE stream. This
// gateway is request/response only, so signal "no stream" with 405.
export function GET() {
  return NextResponse.json(
    { error: 'Use POST for MCP JSON-RPC. The /manifest endpoint returns the descriptor.' },
    { status: 405 },
  );
}
