import { withRequestLogging } from "@/lib/observability/http";
import { AgentApiError, errorResponse } from "@/lib/agents/public-api/errors";
import { createAgentRequestId } from "@/lib/agents/public-api/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const route = "/api/v1/agent-endpoints/[endpointId]/responses";
async function retired() {
  return errorResponse(
    new AgentApiError(
      "runtime_unavailable",
      "The legacy Agent execution API has been retired. Create a newly authorized Pi Agent and use its session routes.",
      410,
    ),
    createAgentRequestId(),
  );
}
export const POST = withRequestLogging(route, retired);
export const OPTIONS = withRequestLogging(route, retired);
