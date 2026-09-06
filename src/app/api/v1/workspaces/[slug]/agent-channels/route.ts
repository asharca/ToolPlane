import { z } from 'zod';
import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import {
  createAgentChannelConnection, deleteAgentChannelConnection, getAgentChannelConnection,
  listAgentChannelConnections, updateAgentChannelConnectionCredentials, moveAgentChannelConnection,
} from '@/lib/agents/channel-connections';
import { getChannelSandbox, listChannelSandboxes } from '@/lib/agents/channel-sandboxes';
import { toAgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { liveAgentChannelStatus, startAgentChannelRunner, stopAgentChannelRunner } from '@/lib/agents/channel-runtime';
import { clearAgentChannelLogs, getAgentChannelLogs } from '@/lib/agents/channel-runtime-logs';
import { applyAgentChannelPairing, checkAgentChannelPairing, requestAgentChannelPairing } from '@/lib/agents/channel-pairing';
import { getMessagingPlatform } from '@/lib/agents/platforms';
import { hostedRunnerSpec } from '@/lib/agents/platform-runner';

export const runtime = 'nodejs';
export const maxDuration = 60;

declare global {
  var __toolplaneChannelCommands: Map<string, Promise<Response>> | undefined;
}

const commandSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'start', 'stop', 'pair', 'check', 'apply', 'move']),
  connectionId: z.string().min(1).max(200).optional(),
  platform: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  agentId: z.string().min(1).max(200).nullable().optional(),
  sandboxId: z.string().min(1).max(200).optional(),
  credentials: z.record(z.string().max(80), z.string().max(8000)).default({}),
  allowedUserIds: z.string().max(4000).default(''),
}).strict().refine((input) => input.action !== 'move' || Boolean(input.sandboxId));

async function authorize(req: Request, slug: string) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const workspace = await getWorkspaceForUser(slug, user.id);
  return workspace ?? Response.json({ error: 'Workspace not found' }, { status: 404 });
}

async function channelList(workspaceId: string, agentId?: string, sandboxId?: string) {
  return (await listAgentChannelConnections(workspaceId, agentId, sandboxId)).map((channel) => ({
    ...toAgentChannelConnectionClientView(channel),
    status: ['running', 'starting'].includes(channel.status)
      ? liveAgentChannelStatus(channel.id) : channel.status,
  }));
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const workspace = await authorize(req, (await params).slug);
  if (workspace instanceof Response) return workspace;
  const query = new URL(req.url).searchParams;
  const sandboxId = query.get('sandboxId') || undefined;
  if (sandboxId && !await getChannelSandbox(workspace.id, sandboxId)) {
    return Response.json({ error: 'Sandbox not found' }, { status: 404 });
  }
  const logId = query.get('logs');
  if (logId) {
    if (!await getAgentChannelConnection(workspace.id, logId)) {
      return Response.json({ error: 'Channel not found' }, { status: 404 });
    }
    return Response.json({ logs: getAgentChannelLogs(logId) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const [connections, agents, sandboxes] = await Promise.all([
    channelList(workspace.id, query.get('agentId') || undefined, sandboxId),
    db.agent.findMany({
      where: { workspaceId: workspace.id, ...ORDINARY_AGENT_FILTER },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    }),
    listChannelSandboxes(workspace.id),
  ]);
  return Response.json({ connections, agents, sandboxes }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const workspace = await authorize(req, (await params).slug);
  if (workspace instanceof Response) return workspace;
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const parsed = commandSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid channel configuration' }, { status: 400 });
  const input = parsed.data;
  let connectionId = input.connectionId;
  const existing = connectionId ? await getAgentChannelConnection(workspace.id, connectionId) : null;
  if (input.action !== 'create' && !existing) {
    return Response.json({ error: 'Channel not found' }, { status: 404 });
  }
  const platform = getMessagingPlatform(existing?.platform ?? input.platform ?? '');
  if (!platform || (input.action === 'create' && !hostedRunnerSpec(platform.slug))) {
    return Response.json({ error: 'Unsupported channel platform' }, { status: 400 });
  }
  const invalidField = Object.entries(input.credentials).some(([key, value]) => {
    const field = platform.credentials.find((field) => field.name === key);
    return !field || (value !== '' && (
      (field.inputType === 'boolean' && !['true', 'false'].includes(value))
      || (field.options && !field.options.some((option) => option.value === value))
    ));
  });
  if (invalidField) return Response.json({ error: 'Invalid channel credentials' }, { status: 400 });

  const execute = async () => {
    let result: { error?: string } = {};
    switch (input.action) {
      case 'create': {
        const created = await createAgentChannelConnection({
          workspaceId: workspace.id, agentId: input.agentId, platform: platform.slug,
          name: input.name, credentials: input.credentials, draft: true, sandboxId: input.sandboxId,
        });
        result = created;
        connectionId = created.connection?.id;
        break;
      }
      case 'update':
        result = await updateAgentChannelConnectionCredentials({
          workspaceId: workspace.id, connectionId: connectionId!,
          name: input.name, agentId: input.agentId, credentials: input.credentials,
        });
        break;
      case 'delete':
        await stopAgentChannelRunner(workspace.id, connectionId!);
        await deleteAgentChannelConnection(workspace.id, connectionId!);
        clearAgentChannelLogs(connectionId!);
        break;
      case 'start': result = await startAgentChannelRunner(workspace.id, connectionId!); break;
      case 'stop': await stopAgentChannelRunner(workspace.id, connectionId!); break;
      case 'pair': result = await requestAgentChannelPairing(workspace.id, connectionId!); break;
      case 'check': result = await checkAgentChannelPairing(workspace.id, connectionId!); break;
      case 'apply': result = await applyAgentChannelPairing(workspace.id, connectionId!, input.allowedUserIds); break;
      case 'move': result = await moveAgentChannelConnection(workspace.id, connectionId!, input.sandboxId!); break;
    }
    return Response.json({ error: result.error, connectionId, connections: await channelList(workspace.id) }, {
      status: result.error ? 400 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  };

  globalThis.__toolplaneChannelCommands ??= new Map();
  const commands = globalThis.__toolplaneChannelCommands;
  const key = connectionId ?? `${workspace.id}:create`;
  const previous = commands.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(execute);
  commands.set(key, operation);
  try { return await operation; }
  catch (error) {
    console.error('[agent-channels] operation failed', error);
    return Response.json({ error: 'Channel operation failed' }, { status: 500 });
  } finally {
    if (commands.get(key) === operation) commands.delete(key);
  }
}
