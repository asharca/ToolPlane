import 'server-only';

type HeaderReader = Pick<Headers, 'get'>;

function firstHeaderValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

function normalizedHttpOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostnameFromHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname || null;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string | null): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function protocolForHost(headers: HeaderReader, host: string): string {
  const forwardedProto = firstHeaderValue(headers.get('x-forwarded-proto'))?.toLowerCase();
  if (forwardedProto === 'http' || forwardedProto === 'https') return forwardedProto;
  return isLocalHostname(hostnameFromHost(host)) ? 'http' : 'https';
}

function configuredOrigin(): string | null {
  return normalizedHttpOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

function requestOriginFromHeaders(headers: HeaderReader): string | null {
  const forwardedHost = firstHeaderValue(headers.get('x-forwarded-host'));
  const host = forwardedHost ?? firstHeaderValue(headers.get('host'));
  if (!host) return null;
  return normalizedHttpOrigin(`${protocolForHost(headers, host)}://${host}`);
}

function resolveOrigin(requestOrigin: string | null): string {
  const configured = configuredOrigin();

  // In production, absolute URLs embedded into install scripts should not be
  // influenced by Host / X-Forwarded-Host. Keep a small dev escape hatch so a
  // local server on :3001/:3002 still generates usable URLs when .env says :3000.
  if (configured) {
    if (requestOrigin && isLocalOrigin(configured) && isLocalOrigin(requestOrigin)) {
      return requestOrigin;
    }
    return configured;
  }

  if (requestOrigin) return requestOrigin;

  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

export function originFromHeaders(headers: HeaderReader): string {
  return resolveOrigin(requestOriginFromHeaders(headers));
}

export function originFromRequest(req: Request): string {
  return resolveOrigin(requestOriginFromHeaders(req.headers) ?? normalizedHttpOrigin(req.url));
}
