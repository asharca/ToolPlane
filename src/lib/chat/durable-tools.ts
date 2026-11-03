import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { AgentToolSet } from "@/lib/agents/agent-tool";
import { McpToolNotDispatchedError } from "@/lib/remote-mcp/pinned-connection";
import {
  chatAccessWhere,
  lockChatRun,
  type ChatRunFence,
  type ChatRunScope,
} from "./run-control";
import { chatExecutionProgressChunk } from "./execution-stage";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

type Scope = ChatRunScope & {
  fence: ChatRunFence;
  signal: AbortSignal;
  onUnknownOutcome?: (error: unknown) => void;
};

// Every tool invocation has a durable, single-use execution record. Authorization
// is checked live; neither a reconnect nor a duplicate call may replay an effect.
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
          // Fence, authorization and durable execution claim commit before invocation.
          const confirmation = await db.$transaction(async (tx) => {
            await lockChatRun(tx, scope.turnId, scope.fence);
            scope.signal.throwIfAborted();
            const authorized = await tx.chatTurn.findFirst({
              where: {
                id: scope.turnId,
                threadId: scope.threadId,
                actorUserId: scope.userId,
                stopRequestedAt: null,
                thread: chatAccessWhere(scope.userId, scope.workspaceId),
              },
            });
            if (!authorized)
              throw new Error("Tool execution authority was revoked.");
            const existing = await tx.chatToolConfirmation.findUnique({
              where: {
                turnId_toolCallId: { turnId: scope.turnId, toolCallId },
              },
            });
            if (existing)
              throw new Error(
                "Tool call already recorded; execution must not be replayed.",
              );
            const claim = await tx.chatToolConfirmation.create({
              data: {
                turnId: scope.turnId,
                toolCallId,
                toolName: name,
                input: json(args),
                status: "executing",
                executionStartedAt: new Date(),
              },
            });
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
                    confirmationId: claim.id,
                  },
                },
              },
            });
            const sequence = authorized.lastEventSequence + 2;
            await tx.chatRunEvent.create({
              data: {
                turnId: scope.turnId,
                generation: scope.fence.generation,
                sequence,
                payload: chatExecutionProgressChunk(
                  scope.turnId,
                  "tool-running",
                  sequence,
                ),
              },
            });
            return claim;
          });
          try {
            if (scope.signal.aborted)
              throw new McpToolNotDispatchedError(scope.signal.reason);
            // Await settlement even after abort: an HTTP cancellation is not evidence
            // that a remote mutation was rolled back.
            const result = await tool.execute(args, ...rest);
            await db.$transaction(async (tx) => {
              const turn = await lockChatRun(tx, scope.turnId, scope.fence);
              await tx.chatToolConfirmation.update({
                where: { id: confirmation.id },
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
              await tx.chatToolConfirmation.updateMany({
                where: { id: confirmation.id, status: "executing" },
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
