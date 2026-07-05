import { findAgentChannelByInboundToken } from '@/lib/agents/channel-connections';
import { runAgentChannelMessage } from '@/lib/agents/message-service';
import {
  getMessagingPlatform,
  normalizePlatformMessageBody,
  type MessagingPlatformSlug,
} from '@/lib/agents/platforms';

export const runtime = 'nodejs';
export const maxDuration = 60;

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.headers.get('x-toolplane-channel-token');
}

async function resolveConnection(req: Request, connectionId: string) {
  const url = new URL(req.url);
  const token = bearerToken(req) || url.searchParams.get('token') || url.searchParams.get('access_token');
  if (!token) return null;
  return findAgentChannelByInboundToken(connectionId, token);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const connection = await resolveConnection(req, connectionId);
  if (!connection) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const platform = getMessagingPlatform(connection.platform);
  if (!platform) return Response.json({ error: 'Unsupported platform' }, { status: 404 });

  const url = new URL(req.url);
  const challenge = url.searchParams.get('hub.challenge') || url.searchParams.get('challenge') || url.searchParams.get('echostr');
  if (challenge) return new Response(challenge, { headers: { 'content-type': 'text/plain' } });

  return Response.json({
    connectionId,
    agentId: connection.agentId,
    platform: platform.slug,
    mode: platform.publicEndpointRequired ? 'callback' : 'hosted-runner',
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const connection = await resolveConnection(req, connectionId);
  if (!connection) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const platform = getMessagingPlatform(connection.platform);
  if (!platform) return Response.json({ error: 'Unsupported platform' }, { status: 404 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  if (platform.slug === 'slack') {
    const body = rawBody && typeof rawBody === 'object' ? rawBody as Record<string, unknown> : {};
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return Response.json({ challenge: body.challenge });
    }
  }

  const normalizedBody = normalizePlatformMessageBody(platform.slug as MessagingPlatformSlug, rawBody);
  const result = await runAgentChannelMessage({
    connectionId,
    workspaceId: connection.workspaceId,
    agentId: connection.agentId,
    rawBody: normalizedBody,
  });
  return Response.json({ ...result.body, connectionId, platform: platform.slug }, { status: result.status });
}
