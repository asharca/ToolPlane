import { handleSshSandboxes } from '@/lib/sandboxes/ssh-management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ slug: string }> };
async function handle(req: Request, context: Context) {
  return handleSshSandboxes(req, (await context.params).slug);
}
export { handle as POST, handle as GET };
