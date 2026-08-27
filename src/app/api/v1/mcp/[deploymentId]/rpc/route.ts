import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { db } from '@/lib/db';
import { proxyMcpRpcRequest } from '@/lib/process/mcp-gateway';
import { ensureHermesRuntimeReady } from '@/lib/agents/hermes/runtime';

// Gateway: proxy a real MCP JSON-RPC request to the live deployment process
// and record it for observability. POST a JSON-RPC 2.0 envelope, e.g.
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspace: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: {
      id: true,
      workspaceId: true,
      mcpToolExposure: true,
      mcpAllowedTools: true,
      sandbox: {
        select: {
          agentRuntime: { select: { agentId: true, kind: true } },
        },
      },
    },
  });
  if (!deployment) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (deployment.sandbox?.agentRuntime?.kind === 'hermes') {
    const ready = await ensureHermesRuntimeReady(
      deployment.workspaceId,
      deployment.sandbox.agentRuntime.agentId,
    );
    if (!ready.port) {
      return NextResponse.json({ error: ready.error || 'Hermes runtime is unavailable.' }, { status: 503 });
    }
  }
  return proxyMcpRpcRequest(req, deployment);
}
