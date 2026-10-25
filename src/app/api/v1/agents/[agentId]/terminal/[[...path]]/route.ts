import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ agentId: string; path?: string[] }> };

async function retired(req: Request, { params }: Params) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const agent = await getAgentForRequest((await params).agentId, user.id);
  if (!agent)
    return Response.json({ error: "Agent not found" }, { status: 404 });
  return Response.json(
    {
      error:
        "Agent-level terminals are retired. Pi terminals belong to a pinned conversation; historical workspaces are read-only.",
    },
    { status: 410 },
  );
}
const route = "/api/v1/agents/[agentId]/terminal/[[...path]]";
export const GET = withRequestLogging(route, retired);
export const POST = withRequestLogging(route, retired);
export const DELETE = withRequestLogging(route, retired);
