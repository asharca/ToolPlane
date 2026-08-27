import { NextResponse } from 'next/server';
import { agentRuntimeTokenFromRequest } from '@/lib/agents/runtime-access';
import { isAgentRuntimeGrantCurrent } from '@/lib/agents/runtime-grant';
import { db } from '@/lib/db';
import { proxyMcpRpcRequest } from '@/lib/process/mcp-gateway';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const token = await agentRuntimeTokenFromRequest(req);
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { deploymentId } = await params;
  if (!token.deploymentIds.includes(deploymentId)) {
    return NextResponse.json({ error: 'deployment is outside the runtime grant' }, { status: 403 });
  }
  if (!await isAgentRuntimeGrantCurrent(token)) {
    return NextResponse.json({ error: 'runtime grant is no longer valid' }, { status: 403 });
  }

  const deployment = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: token.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      mcpToolExposure: true,
      mcpAllowedTools: true,
    },
  });
  if (!deployment) return NextResponse.json({ error: 'deployment not found' }, { status: 404 });
  return proxyMcpRpcRequest(req, deployment);
}
