import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "./queries";
import { withRequestLogging } from "@/lib/observability/http";
import { logSystemEvent } from "@/lib/observability/system";
import {
  ConversationTreeError,
  mutateWorkConversationTree,
} from "./conversation-tree";

const editSchema = z
  .object({ text: z.string().trim().min(1).max(20_000) })
  .strict();

export function conversationTreePost(action: "edit" | "retry" | "branch") {
  return withRequestLogging(
    `/api/v1/agents/[agentId]/conversations/[conversationId]/${action === "retry" ? "retry" : `messages/[messageId]/${action}`}`,
    async (
      request: Request,
      {
        params,
      }: {
        params: Promise<{
          agentId: string;
          conversationId: string;
          messageId?: string;
        }>;
      },
    ) => {
      const user = await resolveRequestUser(request);
      if (!user)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      const { agentId, conversationId, messageId } = await params;
      const agent = await getAgentForRequest(agentId, user.id);
      if (!agent) return Response.json({ error: "notFound" }, { status: 404 });
      let text: string | undefined;
      if (action === "edit") {
        const body = editSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!body.success)
          return Response.json({ error: "invalidText" }, { status: 400 });
        text = body.data.text;
      }
      try {
        const result = await mutateWorkConversationTree({
          workspaceId: agent.workspaceId,
          agentId,
          conversationId,
          actorId: user.id,
          action,
          messageId,
          text,
          signal: request.signal,
        });
        return Response.json(result, {
          status: action === "branch" ? 201 : 202,
        });
      } catch (error) {
        if (error instanceof ConversationTreeError)
          return Response.json({ error: error.code }, { status: error.status });
        const code = error instanceof Error ? error.message : "";
        if (
          [
            "PI_SDK_SESSION_MISSING",
            "PI_SDK_ENTRY_NOT_FOUND",
            "PI_SDK_SESSION_SCOPE",
            "PI_SDK_PACKAGE_SET_CHANGED",
          ].includes(code)
        )
          return Response.json({ error: code }, { status: 409 });
        logSystemEvent("agents.conversation.tree_failed", {
          domain: "agent",
          error,
          workspaceId: agent.workspaceId,
          agentId,
          conversationId,
          actorId: user.id,
        });
        return Response.json(
          { error: "conversationTreeFailed" },
          { status: 502 },
        );
      }
    },
  );
}
