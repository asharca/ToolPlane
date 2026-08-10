import 'server-only';
import { getCurrentUser } from '@/lib/auth/current-user';
import { verifyApiToken, verifyApiTokenContext } from '@/lib/auth/tokens';

// Resolve the caller from a Bearer API token (for external clients) or fall
// back to the dashboard session cookie. Shared by gateway API routes.
export async function resolveRequestUser(req: Request) {
  const viaToken = await verifyApiToken(req.headers.get('authorization'));
  if (viaToken) return viaToken;
  return getCurrentUser();
}

// Agent-control calls can create resources and invoke tools, so they require an
// explicit account-level Bearer token. Toolkit tokens and cookie-only browser
// sessions must never inherit this write capability.
export async function resolveAgentControlRequestUser(req: Request) {
  const authorization = req.headers.get('authorization');
  if (!authorization) return null;
  const context = await verifyApiTokenContext(authorization);
  if (!context || context.token.toolkitId) return null;
  return context.user;
}
