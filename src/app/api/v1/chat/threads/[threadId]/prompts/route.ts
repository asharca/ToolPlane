import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getChatThreadForExecution } from '@/lib/chat/service';
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

async function requestThread(threadId: string, req: Request) {
  const user = await resolveRequestUser(req);
  if (!user) return null;
  return getChatThreadForExecution(user.id, threadId);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const thread = await requestThread(threadId, req);
  if (!thread) return NextResponse.json({ error: 'Chat thread not found.' }, { status: 404 });
  const prompts = await listAttachedMcpPrompts({
    workspaceId: thread.workspaceId,
    deploymentIds: thread.assistant.mcpGrants.map((grant) => grant.deploymentId),
    signal: req.signal,
  });
  return NextResponse.json({ prompts });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const thread = await requestThread(threadId, req);
  if (!thread) return NextResponse.json({ error: 'Chat thread not found.' }, { status: 404 });
  let input: z.infer<typeof PromptRequestSchema>;
  try {
    input = PromptRequestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid MCP prompt request.' }, { status: 400 });
  }

  try {
    const prompt = await resolveAttachedMcpPromptText({
      workspaceId: thread.workspaceId,
      deploymentIds: thread.assistant.mcpGrants.map((grant) => grant.deploymentId),
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
