import { createUIMessageStreamResponse } from "ai";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { workspaceAccessResponse } from "@/lib/workspace/access-stream";
import { getChatThreadForUser } from "@/lib/chat/service";
import {
  chatRunHeaders,
  getChatRunSnapshot,
  subscribeChatRun,
} from "@/lib/chat/run-control";

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
    const thread = await getChatThreadForUser(user.id, threadId);
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    const url = new URL(req.url);
    const runId = url.searchParams.get("runId") ?? undefined;
    const rawCursor =
      url.searchParams.get("afterSequence") ??
      req.headers.get("Last-Event-ID") ??
      "0";
    const afterSequence = Number(rawCursor);
    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(afterSequence))
      return Response.json(
        { error: "Invalid chat event cursor" },
        { status: 400 },
      );
    const options = {
      userId: user.id,
      workspaceId: thread.workspaceId,
      runId,
      afterSequence,
    };
    if (url.searchParams.get("state") === "1") {
      const snapshot = await getChatRunSnapshot(threadId, options);
      return snapshot
        ? Response.json(snapshot)
        : new Response(null, { status: 204 });
    }
    try {
      const output = await subscribeChatRun(
        threadId,
        thread.branch.activeMessageId,
        options,
      );
      if (!output) return new Response(null, { status: 204 });
      return workspaceAccessResponse(
        createUIMessageStreamResponse({
          stream: output.stream,
          headers: chatRunHeaders(output),
        }),
        thread.workspaceId,
        user.id,
        req.signal,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Invalid chat event cursor."
      )
        return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
  },
);
