import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getHermesTerminalForRequest } from '@/lib/agents/queries';
import { ensureHermesDashboardReady } from '@/lib/agents/hermes/runtime';
import { livePort } from '@/lib/process/supervisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_TERMINAL_BODY = 1_000_000;
const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

type RouteParams = Promise<{ agentId: string; path?: string[] }>;

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function resolveTerminal(req: Request, agentId: string) {
  const user = await resolveRequestUser(req);
  if (!user) return { response: error('Unauthorized', 401) };

  const agent = await getHermesTerminalForRequest(agentId, user.id);
  if (!agent?.runtime) return { response: error('Hermes runtime not found', 404) };

  const deploymentId = agent.runtime.sandbox.deploymentId;
  let port = livePort(deploymentId);
  if (!port) {
    const ready = await ensureHermesDashboardReady(agent.workspaceId, agent.id);
    if (!ready.port) {
      return { response: error(ready.error || 'Hermes runtime is unavailable', 503) };
    }
    port = ready.port;
  }
  return { port };
}

async function requestBody(req: Request): Promise<string | Response> {
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_TERMINAL_BODY) {
    return error('Terminal request body is too large', 413);
  }
  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_TERMINAL_BODY) {
    return error('Terminal request body is too large', 413);
  }
  return body || '{}';
}

async function proxyJson(
  req: Request,
  params: RouteParams,
  method: 'POST' | 'DELETE',
) {
  const { agentId, path = [] } = await params;
  const resolved = await resolveTerminal(req, agentId);
  if ('response' in resolved) return resolved.response;

  let targetPath: string | null = null;
  if (method === 'POST' && path.length === 0) {
    targetPath = '/terminal/session';
  } else if (
    method === 'POST'
    && path.length === 2
    && SESSION_ID.test(path[0])
    && ['input', 'resize'].includes(path[1])
  ) {
    targetPath = `/terminal/session/${encodeURIComponent(path[0])}/${path[1]}`;
  } else if (method === 'DELETE' && path.length === 1 && SESSION_ID.test(path[0])) {
    targetPath = `/terminal/session/${encodeURIComponent(path[0])}`;
  }
  if (!targetPath) return error('Terminal endpoint not found', 404);

  const body = method === 'POST' ? await requestBody(req) : undefined;
  if (body instanceof Response) return body;
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${resolved.port}${targetPath}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return error('Hermes terminal is unreachable', 502);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export async function POST(req: Request, { params }: { params: RouteParams }) {
  return proxyJson(req, params, 'POST');
}

export async function DELETE(req: Request, { params }: { params: RouteParams }) {
  return proxyJson(req, params, 'DELETE');
}

export async function GET(req: Request, { params }: { params: RouteParams }) {
  const { agentId, path = [] } = await params;
  if (
    path.length !== 2
    || !SESSION_ID.test(path[0])
    || path[1] !== 'stream'
  ) {
    return error('Terminal endpoint not found', 404);
  }

  const resolved = await resolveTerminal(req, agentId);
  if ('response' in resolved) return resolved.response;
  let upstream: Response;
  try {
    upstream = await fetch(
      `http://127.0.0.1:${resolved.port}/terminal/session/${encodeURIComponent(path[0])}/stream`,
      {
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        signal: req.signal,
      },
    );
  } catch {
    return error('Hermes terminal stream is unreachable', 502);
  }
  if (!upstream.body) return error('Hermes terminal stream is unavailable', 502);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
