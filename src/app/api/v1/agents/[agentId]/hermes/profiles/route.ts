import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/hermes/profiles",
  async function GET(
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
          "Hermes runtime operations are retired. Historical conversations and files are read-only.",
      },
      { status: 410 },
    );
  },
);
