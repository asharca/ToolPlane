import "server-only";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CHAT_TURN_STALE_AFTER_MS } from "./admission";
import { ChatServiceError } from "./shared";

export async function reserveChatBranch(
  userId: string,
  threadId: string,
  anchorMessageId: string,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findFirst({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      select: {
        id: true,
        activeMessageId: true,
        turns: {
          where: {
            status: "pending",
            createdAt: { gte: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS) },
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");

    const anchor = await tx.chatMessage.findFirst({
      where: { id: anchorMessageId, threadId, role: "assistant" },
      select: {
        id: true,
        children: {
          where: { role: "user" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!anchor)
      throw new ChatServiceError(
        400,
        "A branch must start from an assistant message",
      );

    const turn = await tx.chatTurn.create({
      data: { threadId, status: "completed", completedAt: new Date() },
    });
    const reservations = [];
    const reservationCount = anchor.children.length ? 1 : 2;
    for (let index = 0; index < reservationCount; index += 1) {
      reservations.push(
        await tx.chatMessage.create({
          data: {
            threadId,
            turnId: turn.id,
            parentId: anchor.id,
            role: "user",
            parts: [] as Prisma.InputJsonValue,
          },
        }),
      );
    }

    const reservation = reservations.at(-1);
    if (!reservation)
      throw new Error("Chat branch reservation is unavailable.");
    const activated = thread.turns.length === 0;
    const activeMessageId = activated ? reservation.id : thread.activeMessageId;
    const updated = await tx.chatThread.updateMany({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      data: { activeMessageId, updatedAt: new Date() },
    });
    if (!updated.count)
      throw new ChatServiceError(404, "Chat thread not found");
    return { messages: reservations, activeMessageId, activated };
  });
}

export async function deleteReservedChatBranch(
  userId: string,
  threadId: string,
  messageId: string,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findFirst({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      select: { id: true, activeMessageId: true },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");

    const message = await tx.chatMessage.findFirst({
      where: { id: messageId, threadId },
      select: {
        id: true,
        parentId: true,
        role: true,
        parts: true,
        children: { take: 1, select: { id: true } },
      },
    });
    if (
      message?.role !== "user" ||
      !Array.isArray(message.parts) ||
      message.parts.length > 0 ||
      message.children.length > 0
    ) {
      throw new ChatServiceError(400, "Only an empty branch can be deleted");
    }

    const deleted = await tx.chatMessage.deleteMany({
      where: {
        id: message.id,
        thread: { id: threadId, workspace: workspaceAccessWhere(userId) },
      },
    });
    if (!deleted.count)
      throw new ChatServiceError(404, "Chat message not found");
    const activeMessageId =
      thread.activeMessageId === message.id
        ? message.parentId
        : thread.activeMessageId;
    const updated = await tx.chatThread.updateMany({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      data: { activeMessageId, updatedAt: new Date() },
    });
    if (!updated.count)
      throw new ChatServiceError(404, "Chat thread not found");
    return { activeMessageId };
  });
}
