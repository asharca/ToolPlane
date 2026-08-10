export function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedCorsOrigin(
  supplied: string | null,
  allowedOrigins: readonly string[],
): string | null {
  const origin = normalizedOrigin(supplied);
  if (!origin) return null;
  return allowedOrigins.some((candidate) => normalizedOrigin(candidate) === origin) ? origin : null;
}

export function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    vary: 'Origin',
    'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, X-ToolPlane-Conversation-Id',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '600',
  });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-expose-headers', 'X-Request-Id, X-ToolPlane-Conversation-Id, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset');
  }
  return headers;
}

export function preflightResponse(
  request: Request,
  allowedOrigins: readonly string[],
): Response {
  const supplied = request.headers.get('origin');
  const origin = allowedCorsOrigin(supplied, allowedOrigins);
  if (!origin) {
    return new Response(null, {
      status: 403,
      headers: { vary: 'Origin', 'cache-control': 'private, no-store' },
    });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
