import { createUIMessageStreamResponse } from "ai";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { getChatThreadForExecution } from "@/lib/chat/service";
import { subscribeChatRun } from "@/lib/chat/run-control";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/turns/stream",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { threadId } = await params;
    const thread = await getChatThreadForExecution(user.id, threadId);
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    const output = subscribeChatRun(threadId, thread.branch.activeMessageId);
    if (!output) return new Response(null, { status: 204 });
    return workspaceAccessResponse(
      createUIMessageStreamResponse({
        stream: output.stream,
        headers: { "X-Chat-Turn-Id": output.turnId },
      }),
      thread.workspaceId,
      user.id,
      req.signal,
    );
  },
);
