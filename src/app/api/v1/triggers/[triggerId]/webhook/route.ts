import { handleTriggerWebhook } from "@/lib/agents/automation-http";
import { withRequestLogging } from "@/lib/observability/http";
export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/triggers/[triggerId]/webhook",
  async (
    req: Request,
    { params }: { params: Promise<{ triggerId: string }> },
  ) => handleTriggerWebhook(req, (await params).triggerId),
);
