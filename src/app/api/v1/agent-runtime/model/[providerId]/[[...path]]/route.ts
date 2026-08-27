import { NextResponse } from 'next/server';
import { agentRuntimeTokenFromRequest, runtimeProviderUrl } from '@/lib/agents/runtime-access';
import { isAgentRuntimeGrantCurrent } from '@/lib/agents/runtime-grant';
import { handleAnthropicCountTokens, handleAnthropicMessages } from '@/lib/agents/anthropic-gateway';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const STRIPPED_REQUEST_HEADERS = [
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'transfer-encoding',
  'x-api-key',
  'x-toolplane-runtime-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
];

const STRIPPED_RESPONSE_HEADERS = [
  'connection',
  'content-encoding',
  'content-length',
  'set-cookie',
  'transfer-encoding',
];

function upstreamRequestHeaders(req: Request, format: string, apiKey: string): Headers {
  const headers = new Headers(req.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  if (apiKey) {
    if (format === 'anthropic') {
      headers.set('x-api-key', apiKey);
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    } else {
      headers.set('authorization', `Bearer ${apiKey}`);
    }
  }
  return headers;
}

function downstreamResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.set('cache-control', 'no-store');
  return headers;
}

async function proxyProviderRequest(
  req: Request,
  { params }: { params: Promise<{ providerId: string; path?: string[] }> },
) {
  const token = await agentRuntimeTokenFromRequest(req);
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { providerId, path = [] } = await params;
  if (providerId !== token.providerId) {
    return NextResponse.json({ error: 'provider is outside the runtime grant' }, { status: 403 });
  }
  if (!await isAgentRuntimeGrantCurrent(token)) {
    return NextResponse.json({ error: 'runtime grant is no longer valid' }, { status: 403 });
  }

  const provider = await db.modelProvider.findFirst({
    where: { id: providerId, workspaceId: token.workspaceId },
    select: { name: true, format: true, baseUrl: true, apiKey: true },
  });
  if (!provider) return NextResponse.json({ error: 'provider not found' }, { status: 404 });

  const routePath = path.join('/');
  if (req.method === 'POST' && provider.format !== 'anthropic') {
    const gatewayProvider = { id: providerId, ...provider };
    if (routePath === 'v1/messages') return handleAnthropicMessages(req, gatewayProvider);
    if (routePath === 'v1/messages/count_tokens') return handleAnthropicCountTokens(req);
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = runtimeProviderUrl(provider.baseUrl, path, new URL(req.url).search);
  } catch {
    return NextResponse.json({ error: 'provider URL is invalid' }, { status: 502 });
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: upstreamRequestHeaders(req, provider.format, provider.apiKey),
    body: hasBody ? req.body : undefined,
    redirect: 'manual',
    signal: req.signal,
    cache: 'no-store',
  };
  if (hasBody && req.body) init.duplex = 'half';

  try {
    const upstream = await fetch(upstreamUrl, init);
    const body = req.method === 'HEAD' || [204, 205, 304].includes(upstream.status)
      ? null
      : upstream.body;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: downstreamResponseHeaders(upstream),
    });
  } catch {
    return NextResponse.json({ error: 'provider is unreachable' }, { status: 502 });
  }
}

export const GET = proxyProviderRequest;
export const HEAD = proxyProviderRequest;
export const POST = proxyProviderRequest;
export const PUT = proxyProviderRequest;
export const PATCH = proxyProviderRequest;
export const DELETE = proxyProviderRequest;
