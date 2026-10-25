import { z } from "zod";
import { resolveAccountRequestUser } from "@/lib/auth/request-user";
import { withRequestLogging } from "@/lib/observability/http";
import { ChatServiceError, copyChatAssistant } from "@/lib/chat/service";
import { CreateChatAssistantSchema } from "@/lib/chat/schemas";

export const runtime = "nodejs";
const CopySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    expectedRevision: z.number().int().min(1),
    mcpGrants: CreateChatAssistantSchema.shape.mcpGrants.default([]),
  })
  .strict();

export const POST = withRequestLogging(
  "/api/v1/chat/assistants/[assistantId]/copy",
  async (
    req: Request,
    { params }: { params: Promise<{ assistantId: string }> },
  ) => {
    const user = await resolveAccountRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const input = CopySchema.safeParse(await req.json().catch(() => null));
    if (!input.success)
      return Response.json(
        { error: "Invalid Assistant copy request" },
        { status: 400 },
      );
    try {
      const { assistantId } = await params;
      const assistant = await copyChatAssistant(
        user.id,
        assistantId,
        input.data,
      );
      return Response.json({ assistant }, { status: 201 });
    } catch (error) {
      return error instanceof ChatServiceError
        ? Response.json({ error: error.message }, { status: error.status })
        : Response.json({ error: "Assistant copy failed" }, { status: 500 });
    }
  },
);
