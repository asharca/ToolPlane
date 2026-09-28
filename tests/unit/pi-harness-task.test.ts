// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { TaskState } from '@a2a-js/sdk';
import type { A2ATask } from '@prisma/client';
const calls = vi.hoisted(() => ({
  options: vi.fn(), prepare: vi.fn(), bind: vi.fn(), run: vi.fn(), cancel: vi.fn(), grant: vi.fn(),
  current: vi.fn(), owner: true, order: [] as string[],
}));
vi.mock('@/lib/a2a/local-task-options', () => ({ localTaskOptions: calls.options }));
vi.mock('@/lib/a2a/store', () => ({ bindPiHarnessOperation: calls.bind }));
vi.mock('@/lib/a2a/principal', () => ({ assertLiveGrant: calls.grant, isLocalGrant: (grant: { kind: string }) => grant.kind === 'local' }));
vi.mock('@/lib/db', () => ({ db: { a2ATask: { findFirst: calls.current } } }));
vi.mock('@/lib/runtime/ownership-state', () => ({ assertRuntimeOwner: vi.fn(), runtimeCanOperate: () => calls.owner, runtimeAbortSignal: () => undefined }));
vi.mock('@/lib/agents/sandbox-runtime', () => ({ preparePiHarnessOperation: calls.prepare, runPiHarnessOperation: calls.run, cancelPiHarnessOperation: calls.cancel }));
import { executePiHarnessTask, PiRuntimeInterruptedError } from '@/lib/agents/pi-harness';
const row = { id: 'task', contextId: 'context', executionBackend: 'pi-harness', nativeOperationId: null, leaseToken: 'lease',
  grant: { kind: 'local' }, deadlineAt: new Date(Date.now() + 60_000), cancelRequestedAt: null } as unknown as A2ATask;
beforeEach(() => {
  vi.resetAllMocks(); calls.owner = true; calls.order = [];
  calls.options.mockResolvedValue({ runtimeKind: 'pi', sandboxId: 'sandbox' });
  calls.prepare.mockImplementation(async () => { calls.order.push('prepare'); return 'candidate'; });
  calls.bind.mockImplementation(async () => { calls.order.push('bind'); return 'operation'; });
  calls.run.mockImplementation(async () => { calls.order.push('run'); return { status: 'completed', text: 'done' }; });
  calls.cancel.mockResolvedValue({ status: 'aborted', text: '' });
  calls.grant.mockResolvedValue(undefined); calls.current.mockResolvedValue(row);
});
it('persists the selected operation before execution and returns that identity', async () => {
  const result = await executePiHarnessTask(row, new AbortController().signal);
  expect(calls.order).toEqual(['prepare', 'bind', 'run']);
  expect(calls.run.mock.calls[0][1]).toEqual({ taskId: 'task', contextId: 'context', operationId: 'operation' });
  expect(result).toMatchObject({ state: TaskState.TASK_STATE_COMPLETED, nativeOperationId: 'operation' });
});
it('resumes an existing operation without preparing or binding another', async () => {
  await executePiHarnessTask({ ...row, nativeOperationId: 'original' }, new AbortController().signal);
  expect(calls.prepare).not.toHaveBeenCalled(); expect(calls.bind).not.toHaveBeenCalled();
  expect(calls.run.mock.calls[0][1].operationId).toBe('original');
});
it('stops only the driver when ownership is lost', async () => {
  calls.run.mockImplementation(async () => { calls.owner = false; throw new Error('connection lost'); });
  await expect(executePiHarnessTask({ ...row, nativeOperationId: 'original' }, new AbortController().signal)).rejects.toBeInstanceOf(PiRuntimeInterruptedError);
  expect(calls.cancel).not.toHaveBeenCalled();
});
it('preserves completed when cancellation loses the native commit race', async () => {
  calls.cancel.mockResolvedValue({ status: 'completed', text: 'committed first' });
  const result = await executePiHarnessTask({ ...row, nativeOperationId: 'original', cancelRequestedAt: new Date() }, new AbortController().signal);
  expect(calls.run).not.toHaveBeenCalled();
  expect(calls.options.mock.calls[0][3]).toBe(true);
  expect(result.state).toBe(TaskState.TASK_STATE_COMPLETED);
});
it('does not classify model or parameter errors as replayable interruption', async () => {
  const error = new Error('PI_MODEL_UNAVAILABLE'); calls.run.mockRejectedValue(error);
  await expect(executePiHarnessTask({ ...row, nativeOperationId: 'original' }, new AbortController().signal)).rejects.toBe(error);
  expect(calls.cancel).not.toHaveBeenCalled();
});
it('uses owner-only cancellation after revocation rather than driving with old capabilities', async () => {
  calls.grant.mockRejectedValue(new Error('revoked'));
  const result = await executePiHarnessTask({ ...row, nativeOperationId: 'original' }, new AbortController().signal);
  expect(calls.options.mock.calls[0][3]).toBe(true);
  expect(calls.run).not.toHaveBeenCalled();
  expect(result.state).toBe(TaskState.TASK_STATE_CANCELED);
});
