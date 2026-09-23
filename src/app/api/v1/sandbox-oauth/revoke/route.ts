import { handleSandboxOAuth } from '@/lib/sandboxes/oauth-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(req: Request) { return handleSandboxOAuth(req, 'revoke'); }
