import { handleSandboxMcpTokens } from '@/lib/sandboxes/mcp-management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function DELETE(req: Request, context: { params: Promise<{ sandboxId: string; tokenId: string }> }) {
  const { sandboxId, tokenId } = await context.params;
  return handleSandboxMcpTokens(req, sandboxId, tokenId);
}
