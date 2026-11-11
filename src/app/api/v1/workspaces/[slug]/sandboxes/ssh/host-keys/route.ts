import { withRequestLogging } from "@/lib/observability/http";
import { handleSshHostKeys } from "@/lib/sandboxes/ssh-management";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string }> };
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/sandboxes/ssh/host-keys",
  async function POST(req: Request, context: Context) {
    return handleSshHostKeys(req, (await context.params).slug);
  },
);
