import "server-only";
import { TaskState } from "@a2a-js/sdk";
import type { TaskExecutor } from "@/lib/agents/execution/executor";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { db } from "@/lib/db";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  runtimeCanOperate,
} from "@/lib/runtime/ownership-state";
import { findAgentConversationSandbox } from "./conversation-sandbox";
import { cancelPiHarnessOperation } from "./sandbox-runtime";

/** Infrastructure interruption; retained old operations must not be replayed. */
export class PiRuntimeInterruptedError extends Error {
  constructor(
    message = "Pi runtime interrupted; the original operation remains recoverable.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRuntimeInterruptedError";
  }
}

/** Retirement drain only: old operations are canceled, never prepared or resumed. */
export const drainRetiredPiHarnessTask: TaskExecutor = async (row, signal) => {
  assertRuntimeOwner();
  const grant = row.grant as unknown as TaskGrant;
  if (
    row.executionBackend !== "pi-harness" ||
    !isLocalGrant(grant) ||
    !row.leaseToken ||
    !row.nativeOperationId
  )
    throw new Error(
      "Legacy Pi execution is retired; only an already-bound operation may drain.",
    );
  const context = await db.a2AContext.findFirst({
    where: {
      id: row.contextId,
      workspaceId: grant.workspaceId,
      agentId: grant.agentId,
      targetKind: "local",
      ownerKey: grant.ownerKey,
    },
  });
  if (!context) throw new Error("Historical operation context is unavailable.");
  const mapping = await findAgentConversationSandbox({
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    contextId: context.id,
    cleanup: true,
  });
  if (!mapping)
    throw new PiRuntimeInterruptedError(
      "Historical operation workspace is unavailable; its volume was retained.",
    );
  try {
    const result = await cancelPiHarnessOperation(
      {
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        sandboxId: mapping.sandboxId,
        a2aContextId: context.id,
      },
      {
        taskId: row.id,
        contextId: context.id,
        operationId: row.nativeOperationId,
      },
    );
    return {
      state: TaskState.TASK_STATE_CANCELED,
      nativeOperationId: row.nativeOperationId,
      message: result.text,
    };
  } catch (error) {
    if (
      !runtimeCanOperate() ||
      runtimeAbortSignal()?.aborted ||
      signal.reason instanceof PiRuntimeInterruptedError
    )
      throw new PiRuntimeInterruptedError(undefined, { cause: error });
    throw error;
  }
};
