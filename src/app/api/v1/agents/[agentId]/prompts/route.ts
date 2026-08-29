import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { resolveAgentTools } from '@/lib/agents/resolve';
import {
  listAttachedMcpPrompts,
  McpPromptRequestError,
  resolveAttachedMcpPromptText,
} from '@/lib/process/mcp-prompts';

export const runtime = 'nodejs';

const PromptRequestSchema = z.object({
  deploymentId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240),
  arguments: z.record(z.string().min(1).max(240), z.string().max(20_000)).default({}),
}).strict();

async function requestAgent(agentId: string, req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return null;
  const agent = await getAgentForRequest(agentId, user.id);
  return agent;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const agent = await requestAgent(agentId, req);
  if (!agent) return NextResponse.json({ error: 'Agent not found.' }, { status: 404 });
  const resolved = resolveAgentTools(agent);
  const prompts = await listAttachedMcpPrompts({
    workspaceId: agent.workspaceId,
    deploymentIds: resolved.deploymentIds,
    signal: req.signal,
  });
  return NextResponse.json({ prompts });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const agent = await requestAgent(agentId, req);
  if (!agent) return NextResponse.json({ error: 'Agent not found.' }, { status: 404 });
  let input: z.infer<typeof PromptRequestSchema>;
  try {
    input = PromptRequestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid MCP prompt request.' }, { status: 400 });
  }

  try {
    const resolved = resolveAgentTools(agent);
    const prompt = await resolveAttachedMcpPromptText({
      workspaceId: agent.workspaceId,
      deploymentIds: resolved.deploymentIds,
      deploymentId: input.deploymentId,
      name: input.name,
      argumentsValue: input.arguments,
      signal: req.signal,
    });
    return NextResponse.json(prompt);
  } catch (error) {
    if (error instanceof McpPromptRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'MCP prompt is unavailable.' }, { status: 502 });
  }
}
