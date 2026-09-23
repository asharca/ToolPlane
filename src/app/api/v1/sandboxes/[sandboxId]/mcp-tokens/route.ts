import { handleSandboxMcpTokens } from '@/lib/sandboxes/mcp-management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ sandboxId: string }> };
async function handle(req: Request, context: Context) {
  return handleSandboxMcpTokens(req, (await context.params).sandboxId);
}
export { handle as POST, handle as GET };
