import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";

export const runtime = "nodejs";
export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/attachments",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ agentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const agent = await getAgentForRequest((await params).agentId, user.id);
    if (!agent)
      return Response.json({ error: "Agent not found" }, { status: 404 });
    return Response.json(
      {
        error:
          "Agent-level Hermes attachment storage is retired. Use the pinned Pi conversation workspace.",
      },
      { status: 410 },
    );
  },
);
