import { withRequestLogging } from "@/lib/observability/http";
import { handleSessionUi } from "@/lib/agents/execution/work-ui";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/agent-runtime/sessions/ui",
  handleSessionUi,
);
