import { handleSandboxOAuth } from '@/lib/sandboxes/oauth-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(req: Request) { return handleSandboxOAuth(req, 'authorize'); }
export function POST(req: Request) { return handleSandboxOAuth(req, 'authorize'); }
