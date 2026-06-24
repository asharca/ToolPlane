import 'server-only';
import { getCurrentUser } from '@/lib/auth/current-user';
import { verifyApiToken } from '@/lib/auth/tokens';

// Resolve the caller from a Bearer API token (for external clients) or fall
// back to the dashboard session cookie. Shared by gateway API routes.
export async function resolveRequestUser(req: Request) {
  const viaToken = await verifyApiToken(req.headers.get('authorization'));
  if (viaToken) return viaToken;
  return getCurrentUser();
}
