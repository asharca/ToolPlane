import 'server-only';
import { TaskState } from '@a2a-js/sdk';
import type { TaskExecutor } from '@/lib/a2a/executor';
import { localTaskOptions } from '@/lib/a2a/local-task-options';
import { assertLiveGrant, isLocalGrant } from '@/lib/a2a/principal';
import type { TaskGrant } from '@/lib/a2a/principal';
import { bindPiHarnessOperation, projectPiHarnessProgress } from '@/lib/a2a/store';
import { A2A_LIMITS, textArtifact } from '@/lib/a2a/model';
import { db } from '@/lib/db';
import { assertRuntimeOwner, runtimeAbortSignal, runtimeCanOperate } from '@/lib/runtime/ownership-state';
import { withSandboxExecutionLease } from './sandbox-execution-gate';
import { preparePiHarnessOperation, runPiHarnessOperation, cancelPiHarnessOperation } from './sandbox-runtime';
import type { PiHarnessOperationResult } from './sandbox-runtime';

/** Infrastructure interruption, never a user cancellation or model/storage error. */
export class PiRuntimeInterruptedError extends Error {
  constructor(message = 'Pi runtime interrupted; the original operation remains recoverable.', options?: ErrorOptions) {
    super(message, options); this.name = 'PiRuntimeInterruptedError';
  }
}

export const PI_COLLABORATION_INSTRUCTIONS = `You are executing a durable ToolPlane Pi task.
Use a2a_peers to discover authorized targets, a2a_call to delegate and wait, a2a_status to observe, and a2a_cancel to request cancellation.
Targets are agent:<id> or remote:<id>. Only explicitly authorized targets are available.
A2A cancellation is not confirmed until the task reports a terminal state. Never expose credentials or assume shared files.
Native tool calls require a human decision. A denied operation must not be rewritten to evade approval.
An interrupted unsafe tool has an uncertain result; never claim it succeeded or repeat it blindly.`;

const terminalStates: Record<PiHarnessOperationResult['status'], TaskState> = {
  completed: TaskState.TASK_STATE_COMPLETED, declined: TaskState.TASK_STATE_REJECTED,
  aborted: TaskState.TASK_STATE_CANCELED, failed: TaskState.TASK_STATE_FAILED,
};

export const executePiHarnessTask: TaskExecutor = async (row, signal) => {
  assertRuntimeOwner();
  const grant = row.grant as unknown as TaskGrant;
  if (row.executionBackend !== 'pi-harness' || !isLocalGrant(grant) || !row.leaseToken) throw new Error('Not a claimed Pi Harness task.');
  let cleanup = Boolean(row.nativeOperationId && (row.cancelRequestedAt || row.deadlineAt <= new Date()));
  if (row.nativeOperationId && !cleanup) {
    try { await assertLiveGrant(grant, 'send'); } catch { cleanup = true; }
  }
  const options = await localTaskOptions(row, signal, PI_COLLABORATION_INSTRUCTIONS, cleanup);
  if (options.runtimeKind !== 'pi') throw new Error('Pi Harness target runtime changed.');
  return withSandboxExecutionLease(options.sandboxId, async () => {
    const operationId = row.nativeOperationId ?? await bindPiHarnessOperation(row.id, row.leaseToken!,
      await preparePiHarnessOperation(options, row.contextId));
    const binding = { taskId: row.id, contextId: row.contextId, operationId };
    let progressText = '';
    let lastProjection = 0;
    options.onTextDelta = async (delta) => {
      progressText = (progressText + delta).slice(-2048);
      if (Date.now() - lastProjection < 1000) return;
      lastProjection = Date.now();
      // An unavailable observer never cancels the durable operation.
      await projectPiHarnessProgress(row.id, row.leaseToken!, operationId, progressText).catch(() => undefined);
    };
    options.onActivity = async (activity) => {
      if (activity.type !== 'tool') return;
      await projectPiHarnessProgress(row.id, row.leaseToken!, operationId,
        `${activity.toolName ?? 'Tool'}: ${activity.status}`).catch(() => undefined);
    };
    let result: PiHarnessOperationResult;
    try {
      result = cleanup
        ? await cancelPiHarnessOperation(options, binding) : await runPiHarnessOperation(options, binding);
      // Native settlement wins a later cancel marker. Recheck grants before a new
      // effect, not by relabeling an already committed native terminal result.
    } catch (error) {
      if (!runtimeCanOperate() || runtimeAbortSignal()?.aborted || signal.reason instanceof PiRuntimeInterruptedError) {
        throw new PiRuntimeInterruptedError(undefined, { cause: error });
      }
      const current = await db.a2ATask.findFirst({ where: { id: row.id, contextId: row.contextId, leaseToken: row.leaseToken } });
      if (!current) throw new PiRuntimeInterruptedError('Pi task claim changed.', { cause: error });
      let revoked = false;
      try { await assertLiveGrant(grant, 'send'); } catch { revoked = true; }
      if (current.cancelRequestedAt || current.deadlineAt <= new Date() || revoked) {
        // The tracked exec has stopped and been awaited before this exclusive reopen.
        result = await cancelPiHarnessOperation(options, binding);
      } else {
        throw error;
      }
    }
    if (result.text.length > A2A_LIMITS.outputCharacters) throw new Error('Task output limit exceeded.');
    return { state: terminalStates[result.status], nativeOperationId: operationId,
      ...(result.status === 'completed' ? { artifact: textArtifact(result.text) } : { message: result.text || `Pi operation ${result.status}.` }) };
  });
};
