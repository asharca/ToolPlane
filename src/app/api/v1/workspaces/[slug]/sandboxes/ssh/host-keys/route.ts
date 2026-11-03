import { handleSshHostKeys } from "@/lib/sandboxes/ssh-management";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string }> };
export async function POST(req: Request, context: Context) {
  return handleSshHostKeys(req, (await context.params).slug);
}
