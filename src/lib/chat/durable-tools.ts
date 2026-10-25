import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { AgentTool, AgentToolSet } from "@/lib/agents/agent-tool";
import { McpToolNotDispatchedError } from "@/lib/remote-mcp/pinned-connection";
import {
  appendChatRunEvent,
  chatAccessWhere,
  lockChatRun,
  type ChatRunFence,
  type ChatRunScope,
} from "./run-control";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, 200);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

type Scope = ChatRunScope & {
  fence: ChatRunFence;
  signal: AbortSignal;
  requiresConfirmation?: (name: string, tool: AgentTool) => boolean;
  onUnknownOutcome?: (error: unknown) => void;
};

// Only explicitly classified read-only tools may opt out. Remote effects require
// an online, user-bound decision; transport reconnects never grant permission.
export function wrapChatTools(tools: AgentToolSet, scope: Scope): AgentToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (args: Record<string, unknown>, ...rest: unknown[]) => {
          scope.signal.throwIfAborted();
          const options = rest[0] as { toolCallId?: string } | undefined;
          const toolCallId = options?.toolCallId;
          if (!toolCallId)
            throw new Error("Durable tools require a stable toolCallId.");
          const confirmed = scope.requiresConfirmation?.(name, tool) ?? true;
          let confirmationId: string | undefined;
          if (confirmed) {
            const confirmation = await db.$transaction(async (tx) => {
              await lockChatRun(tx, scope.turnId, scope.fence);
              const existing = await tx.chatToolConfirmation.findUnique({
                where: {
                  turnId_toolCallId: { turnId: scope.turnId, toolCallId },
                },
              });
              if (existing)
                throw new Error(
                  "Tool call already recorded; execution must not be replayed.",
                );
              return tx.chatToolConfirmation.create({
                data: {
                  turnId: scope.turnId,
                  toolCallId,
                  toolName: name,
                  input: json(args),
                  expiresAt: new Date(Date.now() + 840_000),
                },
              });
            });
            confirmationId = confirmation.id;
            await appendChatRunEvent(scope, scope.fence, {
              type: "data-chat-tool",
              data: {
                toolCallId,
                toolName: name,
                phase: "awaiting_user",
                confirmationId,
                input: args,
              },
            });
            while (true) {
              scope.signal.throwIfAborted();
              const decision = await db.chatToolConfirmation.findUniqueOrThrow({
                where: { id: confirmationId },
              });
              if (decision.status === "approved") break;
              if (
                decision.status === "awaiting_user" &&
                decision.expiresAt &&
                decision.expiresAt <= new Date()
              ) {
                await db.chatToolConfirmation.updateMany({
                  where: { id: confirmationId, status: "awaiting_user" },
                  data: { status: "rejected", resolvedAt: new Date() },
                });
                throw new Error(
                  "Tool execution was not approved before it expired.",
                );
              }
              if (decision.status !== "awaiting_user")
                throw new Error("Tool execution was not approved.");
              await pause(scope.signal);
            }
          }
          scope.signal.throwIfAborted();
          // Fence, authorization and durable execution claim commit before invocation.
          await db.$transaction(async (tx) => {
            await lockChatRun(tx, scope.turnId, scope.fence);
            const authorized = await tx.chatTurn.findFirst({
              where: {
                id: scope.turnId,
                actorUserId: scope.userId,
                stopRequestedAt: null,
                thread: chatAccessWhere(scope.userId, scope.workspaceId),
              },
            });
            if (!authorized)
              throw new Error("Tool execution authority was revoked.");
            if (confirmationId) {
              const claim = await tx.chatToolConfirmation.updateMany({
                where: {
                  id: confirmationId,
                  status: "approved",
                  approverUserId: scope.userId,
                },
                data: { status: "executing", executionStartedAt: new Date() },
              });
              if (claim.count !== 1)
                throw new Error(
                  "Tool execution was already claimed or not approved by this user.",
                );
            } else if (
              await tx.chatRunEvent.findFirst({
                where: {
                  turnId: scope.turnId,
                  payload: { path: ["data", "toolCallId"], equals: toolCallId },
                },
                select: { id: true },
              })
            ) {
              throw new Error(
                "Tool call already recorded; execution must not be replayed.",
              );
            }
            await tx.chatRunEvent.create({
              data: {
                turnId: scope.turnId,
                generation: scope.fence.generation,
                sequence: authorized.lastEventSequence + 1,
                payload: {
                  type: "data-chat-tool",
                  data: {
                    toolCallId,
                    toolName: name,
                    input: json(args),
                    phase: "tool_calling",
                    ...(confirmationId ? { confirmationId } : {}),
                  },
                },
              },
            });
          });
          try {
            // Await settlement even after abort: an HTTP cancellation is not evidence
            // that a remote mutation was rolled back.
            const result = await tool.execute(args, ...rest);
            await db.$transaction(async (tx) => {
              const turn = await lockChatRun(tx, scope.turnId, scope.fence);
              if (confirmationId)
                await tx.chatToolConfirmation.update({
                  where: { id: confirmationId },
                  data: {
                    status: "succeeded",
                    result: result == null ? Prisma.JsonNull : json(result),
                    executionCompletedAt: new Date(),
                  },
                });
              await tx.chatRunEvent.create({
                data: {
                  turnId: scope.turnId,
                  generation: scope.fence.generation,
                  sequence: turn.lastEventSequence + 1,
                  payload: {
                    type: "data-chat-tool",
                    data: {
                      toolCallId,
                      toolName: name,
                      phase: "succeeded",
                      result: json(result),
                    },
                  },
                },
              });
            });
            return result;
          } catch (error) {
            // Only the transport can prove it never reached tools/call. Everything
            // else may have committed an external mutation, including cancellation.
            const notDispatched = error instanceof McpToolNotDispatchedError;
            const phase = notDispatched ? "failed" : "execution_unknown";
            await db.$transaction(async (tx) => {
              const turn = await lockChatRun(tx, scope.turnId, scope.fence);
              if (confirmationId)
                await tx.chatToolConfirmation.updateMany({
                  where: { id: confirmationId, status: "executing" },
                  data: {
                    status: phase,
                    ...(notDispatched
                      ? { executionCompletedAt: new Date() }
                      : {}),
                    error:
                      error instanceof Error
                        ? error.message
                        : "Remote outcome unknown",
                  },
                });
              await tx.chatRunEvent.create({
                data: {
                  turnId: scope.turnId,
                  generation: scope.fence.generation,
                  sequence: turn.lastEventSequence + 1,
                  payload: {
                    type: "data-chat-tool",
                    data: {
                      toolCallId,
                      toolName: name,
                      phase,
                    },
                  },
                },
              });
            });
            if (!notDispatched) scope.onUnknownOutcome?.(error);
            throw error;
          }
        },
      },
    ]),
  );
}
