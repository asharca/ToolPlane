import { withRequestLogging } from "@/lib/observability/http";
import { handleSandboxMcpTokens } from "@/lib/sandboxes/mcp-management";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sandboxId: string }> };
async function handle(req: Request, context: Context) {
  return handleSandboxMcpTokens(req, (await context.params).sandboxId);
}
const observedHandle = withRequestLogging(
  "/api/v1/sandboxes/[sandboxId]/mcp-tokens",
  handle,
);
export { observedHandle as POST, observedHandle as GET };
