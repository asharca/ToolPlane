import { handleEvolution } from "@/lib/agents/evolution/http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return handleEvolution(req, (await params).agentId, "settings");
}
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/evolution/settings",
  handle,
);
export const PUT = withRequestLogging(
  "/api/v1/agents/[agentId]/evolution/settings",
  handle,
);
