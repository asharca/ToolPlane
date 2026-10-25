import "server-only";
import { db } from "@/lib/db";
import type { SessionMcpContext } from "@/lib/process/session-mcp";
import { resolvePinnedAgent } from "./revisions";

export class AgentSessionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentSessionRequestError";
  }
}

/** Resource requests may only observe the revision bound to an owned session. */
export async function resolveAgentRequestSession<
  T extends { id: string; workspaceId: string; runtimeKind: string },
>(
  agent: T,
  input: { conversationId?: string | null; workSessionId?: string | null },
) {
  const work = input.workSessionId
    ? await db.workSession.findFirst({
        where: {
          id: input.workSessionId,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
        },
        select: {
          conversationId: true,
          agentRevisionId: true,
          legacyRevisionUnresolved: true,
        },
      })
    : null;
  if (input.workSessionId && !work)
    throw new AgentSessionRequestError("Session not found.", 404);
  const conversationId = input.conversationId || work?.conversationId;
  if (!conversationId)
    throw new AgentSessionRequestError(
      "A pinned conversation is required.",
      400,
    );
  if (
    work &&
    input.conversationId &&
    input.conversationId !== work.conversationId
  )
    throw new AgentSessionRequestError("Session bindings conflict.", 409);
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agentId: agent.id,
      publicApiConversation: null,
    },
  });
  if (!conversation)
    throw new AgentSessionRequestError("Session not found.", 404);
  if (
    conversation.legacyRevisionUnresolved ||
    !conversation.agentRevisionId ||
    (work &&
      (work.legacyRevisionUnresolved ||
        work.agentRevisionId !== conversation.agentRevisionId))
  )
    throw new AgentSessionRequestError(
      "Historical Agent sessions are read-only.",
      410,
    );
  const pinned = await resolvePinnedAgent(agent, conversation.agentRevisionId);
  const mcpContext: SessionMcpContext = {
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    agentRevisionId: conversation.agentRevisionId,
    conversationId: conversation.id,
  };
  return { agent: pinned, conversation, mcpContext };
}
