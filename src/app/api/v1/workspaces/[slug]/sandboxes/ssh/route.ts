import { withRequestLogging } from "@/lib/observability/http";
import { handleSshSandboxes } from "@/lib/sandboxes/ssh-management";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Creation tests the SSH login before saving and waits for the runtime.
export const maxDuration = 120;
type Context = { params: Promise<{ slug: string }> };
export const POST = withRequestLogging(
  "/api/v1/workspaces/[slug]/sandboxes/ssh",
  async function POST(req: Request, context: Context) {
    return handleSshSandboxes(req, (await context.params).slug);
  },
);
