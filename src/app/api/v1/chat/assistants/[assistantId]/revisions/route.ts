import { resolveRequestUser } from "@/lib/auth/request-user";
import {
  ChatServiceError,
  listChatAssistantRevisionChangelog,
} from "@/lib/chat/service";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/v1/chat/assistants/[assistantId]/revisions",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ assistantId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const before = new URL(req.url).searchParams.get("beforeVersion");
    const beforeVersion = before === null ? undefined : Number(before);
    if (
      beforeVersion !== undefined &&
      (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)
    )
      return Response.json({ error: "invalidBeforeVersion" }, { status: 400 });
    try {
      const { assistantId } = await params;
      return Response.json(
        await listChatAssistantRevisionChangelog(
          user.id,
          assistantId,
          beforeVersion,
        ),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json({ error: "Chat request failed" }, { status: 500 });
    }
  },
);
