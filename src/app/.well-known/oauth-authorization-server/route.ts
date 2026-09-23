import { sandboxAuthorizationMetadata } from '@/lib/sandboxes/oauth-policy';
import { privateJson } from '@/lib/sandboxes/http-body';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  try { return privateJson(sandboxAuthorizationMetadata()); }
  catch { return privateJson({ error: 'OAuth public origin is not configured.' }, 503); }
}
