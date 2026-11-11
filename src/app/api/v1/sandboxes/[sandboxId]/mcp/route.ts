import { withRequestLogging } from "@/lib/observability/http";
import { handleSandboxMcp } from "@/lib/sandboxes/mcp-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;
type Context = { params: Promise<{ sandboxId: string }> };
async function handle(req: Request, context: Context) {
  return handleSandboxMcp(req, (await context.params).sandboxId);
}
const observedHandle = withRequestLogging(
  "/api/v1/sandboxes/[sandboxId]/mcp",
  handle,
);
export {
  observedHandle as POST,
  observedHandle as GET,
  observedHandle as DELETE,
};
