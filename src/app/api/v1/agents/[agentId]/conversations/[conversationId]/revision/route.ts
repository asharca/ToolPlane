import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import {
  AgentConversationRevisionError,
  getAgentConversationRevisionDiff,
  upgradeAgentConversationRevision,
} from "@/lib/agents/conversation-revisions";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { withRequestLogging } from "@/lib/observability/http";
import { logSystemEvent } from "@/lib/observability/system";

export const runtime = "nodejs";
type Context = { params: Promise<{ agentId: string; conversationId: string }> };

async function handle(req: Request, { params }: Context) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, conversationId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: "notFound" }, { status: 404 });
  const version =
    req.method === "GET"
      ? Number(new URL(req.url).searchParams.get("targetVersion"))
      : (await req.json().catch(() => null))?.targetVersion;
  if (!Number.isSafeInteger(version) || version < 1)
    return Response.json({ error: "invalidTargetVersion" }, { status: 400 });
  const input = {
    workspaceId: agent.workspaceId,
    agentId,
    conversationId,
    targetVersion: version,
  };
  try {
    return Response.json(
      req.method === "GET"
        ? { diff: await getAgentConversationRevisionDiff(input) }
        : await upgradeAgentConversationRevision(input),
    );
  } catch (error) {
    if (error instanceof AgentConversationRevisionError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof AgentRevisionError)
      return Response.json({ error: error.code }, { status: 409 });
    logSystemEvent("agents.conversation.revision_failed", {
      domain: "agent",
      error,
      workspaceId: agent.workspaceId,
      agentId,
      conversationId,
      actorId: user.id,
    });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/revision",
  handle,
);
export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/revision",
  handle,
);
