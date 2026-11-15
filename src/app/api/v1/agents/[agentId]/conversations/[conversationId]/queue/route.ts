import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { withRequestLogging } from "@/lib/observability/http";
import { logSystemEvent } from "@/lib/observability/system";
import {
  AgentMessageQueueError,
  updateAgentMessageQueue,
} from "@/lib/agents/execution/message-queue";

export const runtime = "nodejs";

async function handle(
  req: Request,
  { params }: { params: Promise<{ agentId: string; conversationId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, conversationId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent)
    return Response.json({ error: "CONVERSATION_NOT_FOUND" }, { status: 404 });
  const body =
    req.method === "DELETE" ? null : await req.json().catch(() => null);
  if (
    req.method !== "DELETE" &&
    (!body ||
      !["steer", "follow_up"].includes(body.mode) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 100_000)
  )
    return Response.json({ error: "AGENT_QUEUE_INVALID" }, { status: 400 });
  try {
    return Response.json(
      await updateAgentMessageQueue({
        workspaceId: agent.workspaceId,
        agentId,
        conversationId,
        actorId: user.id,
        message: body ? { mode: body.mode, text: body.text } : null,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AgentMessageQueueError)
      return Response.json({ error: error.code }, { status: error.status });
    logSystemEvent("agents.conversation.queue_failed", {
      domain: "agent",
      error,
      workspaceId: agent.workspaceId,
      agentId,
      conversationId,
      actorId: user.id,
    });
    return Response.json({ error: "AGENT_QUEUE_FAILED" }, { status: 502 });
  }
}

export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/queue",
  handle,
);
export const DELETE = withRequestLogging(
  "/api/v1/agents/[agentId]/conversations/[conversationId]/queue",
  handle,
);
