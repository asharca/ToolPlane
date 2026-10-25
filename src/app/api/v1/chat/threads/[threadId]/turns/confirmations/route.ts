import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { withRequestLogging } from "@/lib/observability/http";
import { getChatThreadForUser } from "@/lib/chat/service";
import { chatAccessWhere } from "@/lib/chat/run-control";

export const runtime = "nodejs";

export const POST = withRequestLogging(
  "/api/v1/chat/threads/[threadId]/turns/confirmations",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { threadId } = await params;
    const thread = await getChatThreadForUser(user.id, threadId);
    if (!thread)
      return Response.json({ error: "Chat thread not found" }, { status: 404 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Invalid confirmation decision" },
        { status: 400 },
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("confirmationId" in body) ||
      typeof body.confirmationId !== "string" ||
      !("approved" in body) ||
      typeof body.approved !== "boolean"
    )
      return Response.json(
        { error: "confirmationId and approved are required" },
        { status: 400 },
      );
    const { confirmationId, approved } = body;
    const result = await db.$transaction(async (tx) => {
      const confirmation = await tx.chatToolConfirmation.findFirst({
        where: {
          id: confirmationId,
          turn: {
            threadId,
            actorUserId: user.id,
            status: "pending",
            stopRequestedAt: null,
            leaseExpiresAt: { gt: new Date() },
            thread: chatAccessWhere(user.id, thread.workspaceId),
          },
        },
      });
      if (!confirmation) return null;
      // Lock the turn before the decision so stop/recovery cannot race approval.
      const turn = await tx.chatTurn.updateMany({
        where: {
          id: confirmation.turnId,
          status: "pending",
          actorUserId: user.id,
          stopRequestedAt: null,
          leaseExpiresAt: { gt: new Date() },
          thread: chatAccessWhere(user.id, thread.workspaceId),
        },
        data: { actorUserId: user.id },
      });
      if (!turn.count) return null;
      const status = approved ? "approved" : "rejected";
      if (confirmation.status !== "awaiting_user")
        return { changed: false, status: confirmation.status };
      const decision = await tx.chatToolConfirmation.updateMany({
        where: { id: confirmation.id, status: "awaiting_user" },
        data: { status, approverUserId: user.id, resolvedAt: new Date() },
      });
      if (!decision.count) return { changed: false, status: "conflict" };
      const current = await tx.chatTurn.findUniqueOrThrow({
        where: { id: confirmation.turnId },
      });
      await tx.chatRunEvent.create({
        data: {
          turnId: current.id,
          generation: current.generation,
          sequence: current.lastEventSequence + 1,
          payload: {
            type: "data-chat-tool",
            data: {
              confirmationId,
              toolCallId: confirmation.toolCallId,
              toolName: confirmation.toolName,
              phase: status,
            },
          },
        },
      });
      return { changed: true, status };
    });
    if (!result)
      return Response.json(
        { error: "Active confirmation not found" },
        { status: 404 },
      );
    if (!result.changed)
      return Response.json(
        { error: "Confirmation already decided", status: result.status },
        { status: 409 },
      );
    return Response.json({ confirmationId, status: result.status });
  },
);
