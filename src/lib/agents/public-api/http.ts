import 'server-only';
import { allowedCorsOrigin, corsHeaders, preflightResponse } from '@/lib/agents/public-api/cors';
import { getPublicEndpointCorsOrigins } from '@/lib/agents/public-api/queries';
import { takeAgentApiPreflightLimit } from '@/lib/agents/public-api/rate-limit';
import { AgentApiError } from '@/lib/agents/public-api/errors';

export async function agentApiHeaders(request: Request, endpointPublicId: string): Promise<Headers> {
  const allowedOrigins = await getPublicEndpointCorsOrigins(endpointPublicId);
  const origin = allowedCorsOrigin(request.headers.get('origin'), allowedOrigins);
  const headers = corsHeaders(origin);
  headers.set('cache-control', 'private, no-store');
  return headers;
}

export async function agentApiPreflight(request: Request, endpointPublicId: string): Promise<Response> {
  try {
    await takeAgentApiPreflightLimit(request);
    return preflightResponse(request, await getPublicEndpointCorsOrigins(endpointPublicId));
  } catch (error) {
    if (error instanceof AgentApiError) {
      return new Response(null, {
        status: error.status,
        headers: {
          'cache-control': 'private, no-store',
          ...(error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}),
        },
      });
    }
    throw error;
  }
}

export function mergeHeaders(...sources: Array<HeadersInit | null | undefined>): Headers {
  const result = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => result.set(key, value));
  }
  return result;
}

export function agentApiJson(
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}
