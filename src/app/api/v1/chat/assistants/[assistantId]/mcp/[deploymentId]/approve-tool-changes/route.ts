import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import {
  ChatServiceError,
  approveChatAssistantMcpToolChanges,
  getChatAssistantForUser,
} from "@/lib/chat/service";

export const runtime = "nodejs";

const BodySchema = z.object({
  toolNames: z.array(z.string().min(1).max(256)).max(1_000).optional(),
});

export const POST = withRequestLogging(
  "/api/v1/chat/assistants/[assistantId]/mcp/[deploymentId]/approve-tool-changes",
  async function POST(
    req: Request,
    {
      params,
    }: { params: Promise<{ assistantId: string; deploymentId: string }> },
  ) {
    const user = await resolveAccountRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { assistantId, deploymentId } = await params;
    const assistant = await getChatAssistantForUser(user.id, assistantId);
    if (!assistant)
      return Response.json(
        { error: "Chat assistant not found" },
        { status: 404 },
      );
    let raw: unknown = {};
    const text = await req.text();
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
      }
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    try {
      const result = await approveChatAssistantMcpToolChanges(
        assistant.workspaceId,
        assistantId,
        deploymentId,
        parsed.data.toolNames,
      );
      return Response.json(result);
    } catch (error) {
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json({ error: "Chat request failed" }, { status: 500 });
    }
  },
);
