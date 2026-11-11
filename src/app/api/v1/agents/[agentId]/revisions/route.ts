import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import {
  AgentConversationRevisionError,
  listAgentRevisionChangelog,
} from "@/lib/agents/conversation-revisions";
import { withRequestLogging } from "@/lib/observability/http";
import { logSystemEvent } from "@/lib/observability/system";

export const runtime = "nodejs";
type Context = { params: Promise<{ agentId: string }> };

async function handle(req: Request, { params }: Context) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: "notFound" }, { status: 404 });
  const before = new URL(req.url).searchParams.get("beforeVersion");
  const beforeVersion = before === null ? undefined : Number(before);
  if (
    beforeVersion !== undefined &&
    (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)
  )
    return Response.json({ error: "invalidBeforeVersion" }, { status: 400 });
  try {
    return Response.json(
      await listAgentRevisionChangelog({
        workspaceId: agent.workspaceId,
        agentId,
        beforeVersion,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AgentConversationRevisionError)
      return Response.json({ error: error.code }, { status: error.status });
    logSystemEvent("agents.revisions.list_failed", {
      domain: "agent",
      error,
      workspaceId: agent.workspaceId,
      agentId,
      actorId: user.id,
    });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/revisions",
  handle,
);
