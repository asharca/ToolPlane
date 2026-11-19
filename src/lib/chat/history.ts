import "server-only";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { chatMessagePath } from "./branches";
import { ChatServiceError, preserveChatModelPart } from "./shared";

export async function getChatHistoryForExecution(
  userId: string,
  threadId: string,
  leafMessageId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: workspaceAccessWhere(userId),
    },
    select: {
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          parentId: true,
          role: true,
          parts: true,
          createdAt: true,
        },
      },
    },
  });
  if (!thread) throw new ChatServiceError(404, "Chat thread not found");
  const path = chatMessagePath(thread.messages, leafMessageId);
  if (path.at(-1)?.id !== leafMessageId)
    throw new ChatServiceError(404, "Chat message not found");
  return path;
}

export async function completeChatTurn(
  threadId: string,
  turnId: string,
  assistantMessageId: string,
  parts: Array<Record<string, unknown>>,
  fence?: { leaseToken: string; generation: number },
) {
  return db.$transaction(async (tx) => {
    const updated = await tx.chatTurn.updateMany({
      where: {
        id: turnId,
        threadId,
        status: "pending",
        ...(fence
          ? { ...fence, leaseExpiresAt: { gt: new Date() } }
          : { leaseToken: null }),
      },
      data: { status: "completed", error: null, completedAt: new Date() },
    });
    if (!updated.count) return false;
    const persisted = await tx.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
      select: {
        generation: true,
        lastEventSequence: true,
        stopRequestedAt: true,
      },
    });
    if (persisted.stopRequestedAt)
      await tx.chatTurn.update({
        where: { id: turnId },
        data: { status: "cancelled" },
      });
    const savedMessage = await tx.chatMessage.findUniqueOrThrow({
      where: { id: assistantMessageId },
      select: { parts: true },
    });
    const message = await tx.chatMessage.updateMany({
      where: {
        id: assistantMessageId,
        threadId,
        turnId,
        role: "assistant",
        status: "pending",
      },
      data: {
        status: persisted.stopRequestedAt ? "cancelled" : "success",
        parts: preserveChatModelPart(
          savedMessage.parts,
          parts,
        ) as Prisma.InputJsonValue,
      },
    });
    if (message.count !== 1)
      throw new ChatServiceError(409, "Chat response is no longer pending");
    await tx.chatThread.updateMany({
      where: { id: threadId, activeMessageId: assistantMessageId },
      data: { updatedAt: new Date() },
    });
    await tx.chatRunEvent.create({
      data: {
        turnId,
        generation: persisted.generation,
        sequence: persisted.lastEventSequence + 1,
        payload: persisted.stopRequestedAt
          ? { type: "abort" }
          : { type: "finish" },
      },
    });
    return true;
  });
}

export async function finishChatTurn(
  threadId: string,
  turnId: string,
  status: "failed" | "cancelled",
  error?: string,
  assistantMessageId?: string,
  parts?: Array<Record<string, unknown>>,
  fence?: { leaseToken: string; generation: number },
) {
  return db.$transaction(async (tx) => {
    const turn = await tx.chatTurn.updateMany({
      where: {
        id: turnId,
        threadId,
        status: "pending",
        ...(fence
          ? { ...fence, leaseExpiresAt: { gt: new Date() } }
          : { leaseToken: null }),
      },
      data: {
        status,
        error: error?.slice(0, 500) ?? null,
        completedAt: new Date(),
      },
    });
    if (!turn.count) return false;
    const persisted = await tx.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
      select: { generation: true, lastEventSequence: true },
    });
    if (assistantMessageId) {
      const savedMessage = await tx.chatMessage.findUniqueOrThrow({
        where: { id: assistantMessageId },
        select: { parts: true },
      });
      const message = await tx.chatMessage.updateMany({
        where: { id: assistantMessageId, threadId, turnId, status: "pending" },
        data: {
          status,
          ...(parts
            ? {
                parts: preserveChatModelPart(
                  savedMessage.parts,
                  parts,
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      if (message.count !== 1)
        throw new ChatServiceError(409, "Chat response is no longer pending");
    }
    await tx.chatRunEvent.create({
      data: {
        turnId,
        generation: persisted.generation,
        sequence: persisted.lastEventSequence + 1,
        payload:
          status === "cancelled"
            ? { type: "abort" }
            : {
                type: "error",
                errorText: error?.slice(0, 500) ?? "Chat turn failed",
              },
      },
    });
    return true;
  });
}
