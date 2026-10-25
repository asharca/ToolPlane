import "server-only";
import { randomUUID } from "node:crypto";
import type { UIMessageChunk } from "ai";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  beginRuntimeOperation,
  runtimeAbortSignal,
} from "@/lib/runtime/ownership-state";
import { systemLog } from "@/lib/observability/system";
import {
  CHAT_TURN_STALE_AFTER_MS,
  completeChatTurn,
  finishChatTurn,
} from "./service";

export type ChatRunFence = { leaseToken: string; generation: number };
export type ChatRunScope = {
  threadId: string;
  turnId: string;
  assistantMessageId: string;
  workspaceId: string;
  userId: string;
};
export type ChatRunOutput = {
  stream: ReadableStream<UIMessageChunk>;
  turnId: string;
  cursor: number;
  status: string;
};
const LEASE_MS = 30_000;
const globals = globalThis as typeof globalThis & {
  __chatRuns?: Map<string, { turnId: string; controller: AbortController }>;
};
globals.__chatRuns ??= new Map();
const runs = globals.__chatRuns;
export function chatRunFenceWhere(turnId: string, fence: ChatRunFence) {
  return {
    id: turnId,
    status: "pending",
    ...fence,
    leaseExpiresAt: { gt: new Date() },
  };
}
export async function lockChatRun(
  tx: Prisma.TransactionClient,
  turnId: string,
  fence: ChatRunFence,
) {
  const claim = await tx.chatTurn.updateMany({
    where: chatRunFenceWhere(turnId, fence),
    data: { leaseToken: fence.leaseToken },
  });
  if (claim.count !== 1) throw new Error("Chat execution lease was lost.");
  return tx.chatTurn.findUniqueOrThrow({ where: { id: turnId } });
}
export function chatAccessWhere(userId: string, workspaceId: string) {
  return {
    workspaceId,
    workspace: {
      status: "active",
      OR: [
        { ownerId: userId, owner: { status: "active" as const } },
        { members: { some: { userId, user: { status: "active" as const } } } },
      ],
    },
  };
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// The event and partial message snapshot commit together, before a subscriber can see either.
export async function appendChatRunEvent(
  scope: ChatRunScope,
  fence: ChatRunFence,
  payload: UIMessageChunk,
) {
  await db.$transaction(async (tx) => {
    const turn = await lockChatRun(tx, scope.turnId, fence);
    if (payload.type === "text-delta" || payload.type === "reasoning-delta") {
      const message = await tx.chatMessage.findUniqueOrThrow({
        where: { id: scope.assistantMessageId },
      });
      const parts = Array.isArray(message.parts)
        ? (message.parts as Array<Record<string, unknown>>)
        : [];
      const kind = payload.type === "text-delta" ? "text" : "reasoning";
      let part = parts.find(
        (item) => item.type === kind && item.id === payload.id,
      );
      if (!part) {
        part = { type: kind, id: payload.id, text: "" };
        parts.push(part);
      }
      part.text = String(part.text ?? "") + payload.delta;
      await tx.chatMessage.update({
        where: { id: message.id },
        data: { parts: json(parts) },
      });
    } else if (
      payload.type === "tool-input-start" ||
      payload.type === "tool-input-available" ||
      payload.type === "tool-output-available" ||
      payload.type === "tool-output-error"
    ) {
      const message = await tx.chatMessage.findUniqueOrThrow({
        where: { id: scope.assistantMessageId },
      });
      const parts = Array.isArray(message.parts)
        ? (message.parts as Array<Record<string, unknown>>)
        : [];
      let part = parts.find((item) => item.toolCallId === payload.toolCallId);
      if (!part) {
        if (!("toolName" in payload))
          throw new Error("Tool output has no persisted input.");
        part = {
          type: "dynamic-tool",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
        };
        parts.push(part);
      }
      if (payload.type === "tool-input-start") part.state = "input-streaming";
      if (payload.type === "tool-input-available") {
        part.state = "input-available";
        part.input = payload.input;
        part.toolName = payload.toolName;
      }
      if (payload.type === "tool-output-available") {
        part.state = "output-available";
        part.output = payload.output;
      }
      if (payload.type === "tool-output-error") {
        part.state = "output-error";
        part.errorText = payload.errorText;
      }
      await tx.chatMessage.update({
        where: { id: message.id },
        data: { parts: json(parts) },
      });
    }
    await tx.chatRunEvent.create({
      data: {
        turnId: scope.turnId,
        generation: fence.generation,
        sequence: turn.lastEventSequence + 1,
        payload: json(payload),
      },
    });
  });
}

// Recovery never restarts a partial provider stream or an effect whose outcome is unknown.
export async function recoverStaleChatRuns(threadId?: string) {
  const stale = await db.chatTurn.findMany({
    where: {
      ...(threadId ? { threadId } : {}),
      status: "pending",
      OR: [
        { leaseExpiresAt: { lte: new Date() } },
        {
          leaseToken: null,
          createdAt: { lt: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS) },
        },
      ],
    },
    select: { id: true, threadId: true },
  });
  for (const candidate of stale) {
    const recovered = await db.$transaction(async (tx) => {
      const claim = await tx.chatTurn.updateMany({
        where: {
          id: candidate.id,
          status: "pending",
          OR: [
            { leaseExpiresAt: { lte: new Date() } },
            {
              leaseToken: null,
              createdAt: {
                lt: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS),
              },
            },
          ],
        },
        data: {
          generation: { increment: 1 },
          leaseToken: null,
          leaseExpiresAt: null,
          status: "failed",
          error: "Execution interrupted: owner lease expired.",
          errorAt: new Date(),
          completedAt: new Date(),
        },
      });
      if (!claim.count) return false;
      const turn = await tx.chatTurn.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      await tx.chatToolConfirmation.updateMany({
        where: { turnId: turn.id, status: "executing" },
        data: {
          status: "execution_unknown",
          error: "Execution owner lost; reconcile externally, do not replay.",
        },
      });
      await tx.chatMessage.updateMany({
        where: { turnId: turn.id, role: "assistant" },
        data: { status: "failed" },
      });
      await tx.chatRunEvent.create({
        data: {
          turnId: turn.id,
          generation: turn.generation,
          sequence: turn.lastEventSequence + 1,
          payload: { type: "error", errorText: turn.error },
        },
      });
      return true;
    });
    if (recovered)
      runs
        .get(candidate.threadId)
        ?.controller.abort(new Error("Chat execution lease expired."));
  }
}

export async function startChatRun(
  scope: ChatRunScope,
  createStream: (
    signal: AbortSignal,
    fence: ChatRunFence,
  ) => ReadableStream<UIMessageChunk>,
  finalize?: (fence: ChatRunFence) => Promise<void>,
): Promise<ChatRunOutput> {
  await recoverStaleChatRuns(scope.threadId);
  const fence = await db.$transaction(async (tx) => {
    const token = randomUUID();
    const claim = await tx.chatTurn.updateMany({
      where: {
        id: scope.turnId,
        threadId: scope.threadId,
        status: "pending",
        leaseToken: null,
        stopRequestedAt: null,
        thread: chatAccessWhere(scope.userId, scope.workspaceId),
      },
      data: {
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        generation: { increment: 1 },
        actorUserId: scope.userId,
        startedAt: new Date(),
      },
    });
    if (!claim.count) return null;
    const turn = await tx.chatTurn.findUniqueOrThrow({
      where: { id: scope.turnId },
    });
    return { leaseToken: token, generation: turn.generation };
  });
  if (fence) {
    const release = beginRuntimeOperation();
    const controller = new AbortController();
    const ownerSignal = runtimeAbortSignal();
    const signal = ownerSignal
      ? AbortSignal.any([controller.signal, ownerSignal])
      : controller.signal;
    runs.set(scope.threadId, { turnId: scope.turnId, controller });
    const deadline = setTimeout(
      () =>
        controller.abort(
          new DOMException("Chat turn timed out.", "TimeoutError"),
        ),
      CHAT_TURN_STALE_AFTER_MS,
    );
    deadline.unref?.();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void db.chatTurn
        .updateMany({
          where: {
            ...chatRunFenceWhere(scope.turnId, fence),
            ...(signal.aborted
              ? {}
              : {
                  stopRequestedAt: null,
                  thread: chatAccessWhere(scope.userId, scope.workspaceId),
                }),
          },
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
        .then(async (claim) => {
          if (claim.count) return;
          const turn = await db.chatTurn.findUnique({
            where: { id: scope.turnId },
          });
          if (turn?.status === "completed") return;
          controller.abort(
            turn?.stopRequestedAt
              ? new DOMException("Chat turn stopped by user.", "AbortError")
              : new Error("Chat execution access or lease was lost."),
          );
        })
        .catch((error) => controller.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 3000);
    timer.unref?.();
    void (async () => {
      // Do not cancel the reader: cancellation can close the UI stream before a
      // remote effect has settled. The execution signal cancels the producer.
      const reader = createStream(signal, fence).getReader();
      let streamFailure: Error | undefined;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Terminal publication belongs to the finalizer transaction, after
          // all buffered nonterminal events and partial snapshots have landed.
          if (value.type === "error") {
            streamFailure = new Error(value.errorText);
            continue;
          }
          if (value.type === "abort") {
            streamFailure = new DOMException(
              "Chat stream aborted.",
              "AbortError",
            );
            continue;
          }
          if (value.type === "finish") continue;
          await appendChatRunEvent(scope, fence, value);
        }
        if (signal.aborted) throw signal.reason;
        if (streamFailure) throw streamFailure;
        if (
          await db.chatToolConfirmation.count({
            where: {
              turnId: scope.turnId,
              status: { in: ["executing", "execution_unknown"] },
            },
          })
        )
          throw new Error(
            "Chat execution interrupted; remote effect outcome unknown. Do not replay.",
          );
        if (finalize) await finalize(fence);
        else {
          const message = await db.chatMessage.findUniqueOrThrow({
            where: { id: scope.assistantMessageId },
          });
          await completeChatTurn(
            scope.threadId,
            scope.turnId,
            scope.assistantMessageId,
            message.parts as Array<Record<string, unknown>>,
            fence,
          );
        }
      } finally {
        reader.releaseLock();
      }
    })()
      .catch(async (error) => {
        controller.abort(error);
        await db.$transaction(async (tx) => {
          await lockChatRun(tx, scope.turnId, fence);
          await tx.chatToolConfirmation.updateMany({
            where: { turnId: scope.turnId, status: "executing" },
            data: {
              status: "execution_unknown",
              error: "Tool execution interrupted; do not replay.",
            },
          });
        });
        const unknownEffects = await db.chatToolConfirmation.count({
          where: { turnId: scope.turnId, status: "execution_unknown" },
        });
        await finishChatTurn(
          scope.threadId,
          scope.turnId,
          !unknownEffects && error?.name === "AbortError"
            ? "cancelled"
            : "failed",
          unknownEffects
            ? "Chat execution interrupted; remote effect outcome unknown. Do not replay."
            : error instanceof Error
              ? error.message
              : "Chat turn failed",
          scope.assistantMessageId,
          undefined,
          fence,
        );
      })
      .catch((error) =>
        systemLog("error", "[chat] background persistence failed", error),
      )
      .finally(() => {
        clearTimeout(deadline);
        clearInterval(timer);
        if (runs.get(scope.threadId)?.controller === controller)
          runs.delete(scope.threadId);
        release();
      });
  }
  const output = await subscribeChatRun(
    scope.threadId,
    scope.assistantMessageId,
    {
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      runId: scope.turnId,
    },
  );
  if (!output) throw new Error("Chat run subscription is unavailable.");
  return output;
}

export async function subscribeChatRun(
  threadId: string,
  assistantMessageId: string | null,
  options: {
    userId: string;
    workspaceId: string;
    runId?: string;
    afterSequence?: number;
  },
): Promise<ChatRunOutput | null> {
  await recoverStaleChatRuns(threadId);
  const turn = await db.chatTurn.findFirst({
    where: {
      threadId,
      ...(options.runId
        ? { id: options.runId }
        : {
            messages: {
              some: { id: assistantMessageId ?? "", role: "assistant" },
            },
          }),
      thread: chatAccessWhere(options.userId, options.workspaceId),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!turn) return null;
  let cursor = options.afterSequence ?? 0;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > turn.lastEventSequence
  )
    throw new Error("Invalid chat event cursor.");
  let closed = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    turnId: turn.id,
    cursor,
    status: turn.status,
    stream: new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        while (!closed) {
          const authorized = await db.chatThread.findFirst({
            where: {
              id: threadId,
              ...chatAccessWhere(options.userId, options.workspaceId),
            },
            select: { id: true },
          });
          if (!authorized) {
            closed = true;
            controller.close();
            return;
          }
          const events = await db.chatRunEvent.findMany({
            where: { turnId: turn.id, sequence: { gt: cursor } },
            orderBy: { sequence: "asc" },
            take: 128,
          });
          if (closed) return;
          if (events.length) {
            for (const event of events) {
              cursor = event.sequence;
              controller.enqueue(event.payload as unknown as UIMessageChunk);
              controller.enqueue({
                type: "data-chat-cursor",
                data: { runId: turn.id, sequence: cursor },
                transient: true,
              });
            }
            return;
          }
          const current = await db.chatTurn.findUnique({
            where: { id: turn.id },
            select: { status: true, lastEventSequence: true },
          });
          if (
            !current ||
            (current.status !== "pending" &&
              current.lastEventSequence === cursor)
          ) {
            closed = true;
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, 200);
          });
          await recoverStaleChatRuns(threadId);
        }
      },
      cancel() {
        closed = true;
        clearTimeout(timer);
        wake?.();
      },
    }),
  };
}
export async function cancelChatRun(threadId: string, turnId: string) {
  const requested = await db.$transaction(async (tx) => {
    const claim = await tx.chatTurn.updateMany({
      where: { id: turnId, threadId, status: "pending" },
      data: { stopRequestedAt: new Date() },
    });
    if (!claim.count) return false;
    const turn = await tx.chatTurn.findUniqueOrThrow({ where: { id: turnId } });
    if (!turn.leaseToken) {
      await tx.chatRunEvent.create({
        data: {
          turnId,
          generation: turn.generation,
          sequence: turn.lastEventSequence + 1,
          payload: { type: "abort" },
        },
      });
      await tx.chatTurn.update({
        where: { id: turnId },
        data: { status: "cancelled", completedAt: new Date() },
      });
      await tx.chatMessage.updateMany({
        where: { turnId, role: "assistant", status: "pending" },
        data: { status: "cancelled" },
      });
    }
    return true;
  });
  if (!requested) return false;
  const run = runs.get(threadId);
  if (run?.turnId === turnId)
    run.controller.abort(
      new DOMException("Chat turn stopped by user.", "AbortError"),
    );
  await recoverStaleChatRuns(threadId);
  return true;
}

export function chatRunHeaders(output: ChatRunOutput) {
  return {
    "X-Chat-Turn-Id": output.turnId,
    "X-Chat-Run-Id": output.turnId,
    "X-Chat-Cursor": String(output.cursor),
    "X-Chat-Run-Status": output.status,
  };
}

export async function getChatRunSnapshot(
  threadId: string,
  options: { userId: string; workspaceId: string; runId?: string },
) {
  await recoverStaleChatRuns(threadId);
  const turn = await db.chatTurn.findFirst({
    where: {
      threadId,
      ...(options.runId ? { id: options.runId } : {}),
      thread: chatAccessWhere(options.userId, options.workspaceId),
    },
    orderBy: { createdAt: "desc" },
    include: {
      confirmations: { orderBy: { createdAt: "asc" } },
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          role: true,
          parentId: true,
          parts: true,
          status: true,
        },
      },
    },
  });
  if (!turn) return null;
  const phase = turn.confirmations.some(
    (item) => item.status === "execution_unknown",
  )
    ? "execution_unknown"
    : turn.status !== "pending"
      ? turn.error?.includes("interrupted") ||
        turn.error?.includes("owner lease expired")
        ? "interrupted"
        : turn.status
      : turn.stopRequestedAt
        ? "stopping"
        : turn.confirmations.some((item) => item.status === "executing")
          ? "tool_calling"
          : turn.confirmations.some((item) => item.status === "awaiting_user")
            ? "awaiting_user"
            : turn.startedAt
              ? "generating"
              : "queued";
  return {
    runId: turn.id,
    turnId: turn.id,
    status: turn.status,
    phase,
    cursor: turn.lastEventSequence,
    generation: turn.generation,
    stopRequested: !!turn.stopRequestedAt,
    error: turn.error,
    messages: turn.messages,
    confirmations: turn.confirmations,
  };
}
