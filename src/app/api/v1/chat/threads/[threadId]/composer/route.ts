import { withRequestLogging } from '@/lib/observability/http';
import { z } from 'zod';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getChatThreadForExecution } from '@/lib/chat/service';
import { getMcpPromptSources, McpPromptRequestError } from '@/lib/process/mcp-prompts';
import {
  listAttachedMcpResources,
  readAttachedMcpResource,
} from '@/lib/process/mcp-resources';
import { liveStatus } from '@/lib/process/supervisor';

export const runtime = 'nodejs';

const ListSchema = z.object({ section: z.enum(['mcp', 'resources']) }).strict();
const ResolveSchema = z.object({
  kind: z.literal('resource'),
  id: z.string().trim().min(1).max(4000),
  deploymentId: z.string().trim().min(1).max(240),
}).strict();

async function requestThread(req: Request, threadId: string) {
  const user = await resolveRequestUser(req);
  if (!user) return null;
  return getChatThreadForExecution(user.id, threadId);
}

export const GET = withRequestLogging("/api/v1/chat/threads/[threadId]/composer", async function GET(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const thread = await requestThread(req, threadId);
  if (!thread) return Response.json({ error: 'Chat thread not found.' }, { status: 404 });
  const input = ListSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) {
    return Response.json({ error: 'Invalid composer request.' }, { status: 400 });
  }
  const deploymentIds = thread.assistant.mcpGrants.map((grant) => grant.deploymentId);
  try {
    if (input.data.section === 'mcp') {
      const sources = await getMcpPromptSources(thread.workspaceId, deploymentIds);
      return Response.json({
        items: sources.map((source) => ({
          id: source.deploymentId,
          label: source.serverName,
          status: liveStatus(source.deploymentId) === 'running' ? 'running' : 'unavailable',
        })),
      });
    }
    const resources = await listAttachedMcpResources({
      workspaceId: thread.workspaceId,
      deploymentIds,
      signal: req.signal,
    });
    return Response.json({
      items: resources.map((resource) => ({
        kind: 'resource',
        id: resource.uri,
        deploymentId: resource.deploymentId,
        label: resource.name,
        description: resource.description ?? resource.serverName,
      })),
    });
  } catch {
    return Response.json({ error: 'MCP resources are unavailable.' }, { status: 502 });
  }
});

export const POST = withRequestLogging("/api/v1/chat/threads/[threadId]/composer", async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const thread = await requestThread(req, threadId);
  if (!thread) return Response.json({ error: 'Chat thread not found.' }, { status: 404 });
  const input = ResolveSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: 'Invalid MCP resource request.' }, { status: 400 });
  try {
    const result = await readAttachedMcpResource({
      workspaceId: thread.workspaceId,
      deploymentIds: thread.assistant.mcpGrants.map((grant) => grant.deploymentId),
      deploymentId: input.data.deploymentId,
      uri: input.data.id,
      signal: req.signal,
    });
    const body = result.text.length > 17_000 ? `${result.text.slice(0, 17_000)}\n[Truncated]` : result.text;
    return Response.json({
      kind: 'resource',
      id: input.data.id,
      deploymentId: input.data.deploymentId,
      label: result.resource.name,
      text: `Reference material (resource): ${result.resource.name}\n${input.data.id}\n${body}`,
    });
  } catch (error) {
    if (error instanceof McpPromptRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'MCP resource is unavailable.' }, { status: 502 });
  }
});
