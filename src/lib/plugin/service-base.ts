import 'server-only';
import { originFromHeaders, originFromRequest } from '@/lib/http/origin';
import { runtimeEnv } from '@/lib/runtime-env';

// Origins remain origin-only for CSRF checks. Install identities and generated
// endpoints additionally preserve a trusted deployment's configured base path.
function configuredBase(origin: string): string {
  const raw = runtimeEnv('NEXT_PUBLIC_APP_URL');
  if (!raw) return origin;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid public installation URL.');
  return url.origin === origin ? origin + url.pathname.replace(/\/+$/, '') : origin;
}
export function installBaseFromRequest(req: Request): string { return configuredBase(originFromRequest(req)); }
export function installBaseFromHeaders(headers: Pick<Headers, 'get'>): string { return configuredBase(originFromHeaders(headers)); }
