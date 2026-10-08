// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import type { A2ATask } from '@prisma/client';
import { db } from '@/lib/db';
import { childGrant, createLocalRootGrant } from '@/lib/a2a/local-policy';
import type { LocalA2AGrant } from '@/lib/a2a/principal';
import type { TaskExecutor } from '@/lib/a2a/executor';
import { A2A_LIMITS, textArtifact } from '@/lib/a2a/model';
import { outputBucket } from '@/lib/a2a/quotas';
import { bindPiHarnessOperation, claimTask, finishTask, getTaskRow, releasePiHarnessClaim, requestCancellation, submitTask } from '@/lib/a2a/store';
import { executeA2ATask, startA2AWorker, stopA2AWorker } from '@/lib/a2a/worker';
import { assertLocalRuntimeToken } from '@/lib/a2a/local-runtime';
import { checkNativeToolApproval, decideNativeToolApproval } from '@/lib/a2a/tool-approvals';
import { PiRuntimeInterruptedError } from '@/lib/agents/pi-harness';
import type { AgentRuntimeTokenPayload } from '@/lib/agents/runtime-access';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';

// Real PostgreSQL claims, receipts, approvals and worker control. Inject only the
// TaskExecutor boundary; actual SQLite/process crash recovery has its own suite.
let workspaceId: string, userId: string, providerId: string;
const pi: Array<{ id: string; sandboxId: string }> = [];
const legacy: Array<{ id: string; sandboxId: string }> = [];
let piGrants: LocalA2AGrant[], legacyGrants: LocalA2AGrant[];
const executions: Promise<unknown>[] = [];
const request = () => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Worker control fixture' }] },
});
function execute(id: string, executor: TaskExecutor) {
  const operation = executeA2ATask(id, executor);
  executions.push(operation);
  return operation;
}
async function startWorker() {
  await startA2AWorker();
  // Disable background scheduling, not PostgreSQL timers or the real clock.
  // Watchdogs created subsequently can still be advanced explicitly.
  vi.clearAllTimers();
}
async function running(authority = piGrants[0]) {
  const row = await submitTask(authority, request());
  const claimed = await claimTask(row.id);
  if (!claimed?.leaseToken) throw new Error('Fixture task was not claimed.');
  return claimed;
}
async function completed(row: A2ATask) {
  const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, row.nativeOperationId ?? randomUUID());
  return { state: TaskState.TASK_STATE_COMPLETED, nativeOperationId, artifact: textArtifact('Native fixture result') };
}
function aborted(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(signal.reason);
  const { promise, resolve } = Promise.withResolvers<unknown>();
  signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  return promise;
}
function token(row: A2ATask): AgentRuntimeTokenPayload {
  return { workspaceId, agentId: pi[0].id, sandboxId: pi[0].sandboxId, providerId, deploymentIds: [],
    exp: Math.floor(Date.now() / 1000) + 300, a2aTaskId: row.id, a2aLeaseToken: row.leaseToken!, a2aApprovalRequired: true };
}

beforeAll(async () => {
  if (process.env.TOOLPLANE_TEST_PGLITE === '1') throw new Error('Pi worker checks require real PostgreSQL.');
  const stamp = randomUUID();
  userId = (await db.user.create({ data: { email: `pi-worker-${stamp}@test.invalid`, passwordHash: 'x' } })).id;
  workspaceId = (await db.workspace.create({ data: { slug: `pi-worker-${stamp}`, name: 'Pi worker fixture', ownerId: userId } })).id;
  providerId = (await db.modelProvider.create({ data: { workspaceId, name: 'Fixture', format: 'openai',
    baseUrl: 'https://model.test.invalid', apiKey: 'fixture' } })).id;
  for (const runtimeKind of ['pi', 'claude-code']) {
    for (let index = 0; index <= A2A_LIMITS.workerConcurrency; index++) {
      const name = `${runtimeKind}-${index}`;
      const deployment = await db.deployment.create({ data: { workspaceId, name, source: 'config' } });
      const sandbox = await db.sandbox.create({ data: { workspaceId, deploymentId: deployment.id, name, slug: name, kind: 'docker', network: 'isolated' } });
      const agent = await db.agent.create({ data: { workspaceId, name, slug: name, runtimeKind, providerId, model: 'fixture',
        a2aInternalEnabled: true, sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
      (runtimeKind === 'pi' ? pi : legacy).push({ id: agent.id, sandboxId: sandbox.id });
    }
  }
  await db.agentSubAgent.create({ data: { parentId: pi[0].id, childId: pi[1].id } });
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  stopA2AWorker();
  await db.a2AContext.deleteMany({ where: { workspaceId } });
  await db.agentApiUsageBucket.deleteMany({ where: { key: outputBucket('workspace', workspaceId) } });
  await db.agent.updateMany({ where: { workspaceId }, data: { a2aInternalEnabled: true } });
  await db.sandbox.updateMany({ where: { workspaceId }, data: { network: 'isolated' } });
  piGrants = await Promise.all(pi.map((agent) => createLocalRootGrant(workspaceId, agent.id, userId)));
  legacyGrants = await Promise.all(legacy.map((agent) => createLocalRootGrant(workspaceId, agent.id, userId)));
  await startWorker();
});
afterEach(async () => {
  stopA2AWorker();
  await Promise.allSettled(executions.splice(0));
  vi.useRealTimers();
});
afterAll(async () => {
  if (workspaceId) {
    await db.logEvent.deleteMany({ where: { workspaceId } });
    await db.agentApiUsageBucket.deleteMany({ where: { key: outputBucket('workspace', workspaceId) } });
    await db.auditEvent.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('Pi worker recovery and terminal projection in PostgreSQL', () => {
  it('recovers the same native task/context/operation at startup but fails uncertain legacy execution', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await db.a2ATask.update({ where: { id: row.id }, data: { resumeCount: 2, approvalReadyLease: row.leaseToken } });
    const old = await running(legacyGrants[0]);
    stopA2AWorker();
    await startWorker();
    const recovered = await getTaskRow(piGrants[0], row.id);
    expect(recovered).toMatchObject({ id: row.id, contextId: row.contextId, nativeOperationId,
      executionBackend: 'pi-harness', state: TaskState.TASK_STATE_WORKING, phase: 'resumable',
      leaseToken: null, approvalReadyLease: null, resumeCount: 2, cancelRequestedAt: null });
    expect(Task.fromJSON(recovered.snapshot).history).toEqual(Task.fromJSON(row.snapshot).history);
    expect((await getTaskRow(legacyGrants[0], old.id)).state).toBe(TaskState.TASK_STATE_FAILED);
    const executor = vi.fn<TaskExecutor>(async (resumed) => completed(resumed));
    await execute(row.id, executor);
    const resumed = executor.mock.calls[0]?.[0];
    expect(resumed).toMatchObject({ id: row.id, contextId: row.contextId, nativeOperationId, resumeCount: 2 });
    expect(resumed?.leaseToken).not.toBe(row.leaseToken);
    expect((await getTaskRow(piGrants[0], row.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(await db.a2ATask.count({ where: { context: { workspaceId } } })).toBe(2);
    expect(await db.a2ARequest.count({ where: { taskId: row.id } })).toBe(1);
  });

  it('releases interrupted claims without replay history and requires fresh lease-bound approval', async () => {
    const initial = await submitTask(piGrants[0], request());
    await db.a2ATask.update({ where: { id: initial.id }, data: { resumeCount: 2 } });
    const nativeOperationId = randomUUID();
    const input = { action: 'check' as const, callId: 'durable-write', toolName: 'write', input: { path: 'approved.txt', content: 'one' } };
    const actor = { workspaceId, actorId: userId, agentId: pi[0].id, slug: 'pi-worker' };
    let oldToken!: AgentRuntimeTokenPayload;
    let oldApprovalId = '';
    await execute(initial.id, async (row) => {
      await bindPiHarnessOperation(row.id, row.leaseToken!, nativeOperationId);
      oldToken = token(row);
      await checkNativeToolApproval(oldToken, { action: 'ready' });
      const approval = await checkNativeToolApproval(oldToken, input);
      oldApprovalId = approval.approvalId!;
      expect(approval.status).toBe('allow');
      expect((await checkNativeToolApproval(oldToken, input)).status).toBe('deny');
      throw new PiRuntimeInterruptedError();
    });
    const interrupted = await getTaskRow(piGrants[0], initial.id);
    expect(interrupted).toMatchObject({ id: initial.id, contextId: initial.contextId, nativeOperationId,
      state: TaskState.TASK_STATE_WORKING, phase: 'resumable', leaseToken: null, approvalReadyLease: null, resumeCount: 2 });
    expect(Task.fromJSON(interrupted.snapshot).history).toEqual(Task.fromJSON(initial.snapshot).history);
    await expect(assertLocalRuntimeToken(oldToken)).rejects.toThrow();
    const executor = vi.fn<TaskExecutor>(async (row) => {
      const fresh = token(row);
      expect(fresh.a2aLeaseToken).not.toBe(oldToken.a2aLeaseToken);
      await expect(assertLocalRuntimeToken(fresh)).rejects.toThrow();
      await expect(checkNativeToolApproval(oldToken, input)).rejects.toThrow();
      await checkNativeToolApproval(fresh, { action: 'ready' });
      await expect(assertLocalRuntimeToken(fresh)).resolves.toBeDefined();
      const approval = await checkNativeToolApproval(fresh, input);
      expect(approval.status).toBe('allow');
      expect(approval.approvalId).not.toBe(oldApprovalId);
      await expect(decideNativeToolApproval(actor, { rootTaskId: row.id, taskId: row.id, approvalId: oldApprovalId,
        inputHash: approval.inputHash!, decision: 'approved' })).rejects.toThrow();
      expect((await checkNativeToolApproval(fresh, input)).status).toBe('deny');
      return completed(row);
    });
    await execute(initial.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await getTaskRow(piGrants[0], initial.id)).toMatchObject({ state: TaskState.TASK_STATE_COMPLETED, nativeOperationId, resumeCount: 2 });
    const approvals = await db.a2AToolApproval.findMany({ where: { taskId: initial.id } });
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((approval) => approval.leaseToken)).size).toBe(2);
    expect(approvals.every((approval) => approval.status === 'consumed')).toBe(true);
  });

  it('stops an owner with infrastructure interruption, not native user cancellation', async () => {
    const initial = await submitTask(piGrants[0], request());
    const entered = Promise.withResolvers<void>();
    let reason: unknown;
    let nativeOperationId = '';
    const execution = execute(initial.id, async (row, signal) => {
      nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
      await checkNativeToolApproval(token(row), { action: 'ready' });
      entered.resolve();
      reason = await aborted(signal);
      if (reason instanceof PiRuntimeInterruptedError) throw reason;
      return { state: TaskState.TASK_STATE_CANCELED, nativeOperationId };
    });
    await Promise.race([entered.promise, execution.then(() => { throw new Error('Executor did not start.'); })]);
    stopA2AWorker();
    await execution;
    expect(reason).toBeInstanceOf(PiRuntimeInterruptedError);
    expect(await getTaskRow(piGrants[0], initial.id)).toMatchObject({ id: initial.id, contextId: initial.contextId, nativeOperationId,
      state: TaskState.TASK_STATE_WORKING, phase: 'resumable', cancelRequestedAt: null, leaseToken: null, approvalReadyLease: null, resumeCount: 0 });
    await startWorker();
    await execute(initial.id, completed);
    expect(await getTaskRow(piGrants[0], initial.id)).toMatchObject({ state: TaskState.TASK_STATE_COMPLETED, nativeOperationId });
  });

  it('projects an already completed native result even after the cancellation watchdog aborts', async () => {
    const initial = await submitTask(piGrants[0], request());
    const entered = Promise.withResolvers<AbortSignal>();
    const execution = execute(initial.id, async (row, signal) => {
      const result = { ...await completed(row), artifact: textArtifact('Committed before cancel') };
      entered.resolve(signal);
      await aborted(signal);
      return result;
    });
    const signal = await Promise.race([entered.promise, execution.then(() => { throw new Error('Executor did not start.'); })]);
    expect((await requestCancellation(piGrants[0], initial.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    await vi.advanceTimersByTimeAsync(1000);
    await execution;
    expect(signal.aborted).toBe(true);
    const result = await getTaskRow(piGrants[0], initial.id);
    expect(result).toMatchObject({ state: TaskState.TASK_STATE_COMPLETED, cancelRequestedAt: expect.any(Date) });
    expect(Task.fromJSON(result.snapshot).artifacts[0].parts[0].content).toEqual({ $case: 'text', value: 'Committed before cancel' });
  });

  it.each(['cancel', 'deadline', 'revoked', 'expired grant'] as const)('executes bound native cleanup after %s and durably projects CANCELED', async (stop) => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    if (stop === 'cancel') await requestCancellation(piGrants[0], row.id);
    else if (stop === 'deadline') await db.a2ATask.update({ where: { id: row.id }, data: { deadlineAt: new Date(0) } });
    else if (stop === 'revoked') await db.agent.update({ where: { id: pi[0].id }, data: { a2aInternalEnabled: false } });
    else await db.a2ATask.update({ where: { id: row.id }, data: { grant: { ...piGrants[0], expiresAt: 1 } } });
    const executor = vi.fn<TaskExecutor>(async (cleanup) => ({ state: TaskState.TASK_STATE_CANCELED, nativeOperationId: cleanup.nativeOperationId! }));
    await execute(row.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toMatchObject({ id: row.id, contextId: row.contextId, nativeOperationId });
    expect(await getTaskRow(piGrants[0], row.id)).toMatchObject({ state: TaskState.TASK_STATE_CANCELED, phase: 'done', nativeOperationId, leaseToken: null });
    stopA2AWorker();
    await startWorker();
    await execute(row.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await claimTask(row.id)).toBeNull();
    expect((await getTaskRow(piGrants[0], row.id)).state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('settles a fatal error after binding instead of losing its operation or making it resumable', async () => {
    const initial = await submitTask(piGrants[0], request());
    const nativeOperationId = randomUUID();
    await execute(initial.id, async (row) => {
      await bindPiHarnessOperation(row.id, row.leaseToken!, nativeOperationId);
      throw new Error('PI_SESSION_CORRUPT');
    });
    expect(await getTaskRow(piGrants[0], initial.id)).toMatchObject({ state: TaskState.TASK_STATE_FAILED, phase: 'done',
      nativeOperationId, leaseToken: null, resumeCount: 0 });
    expect(await claimTask(initial.id)).toBeNull();
  });

  it('fails an unavailable unbound target visibly without running the executor', async () => {
    const initial = await submitTask(piGrants[0], request());
    await db.sandbox.update({ where: { id: pi[0].sandboxId }, data: { network: 'none' } });
    const executor = vi.fn<TaskExecutor>(completed);
    await execute(initial.id, executor);
    expect(executor).not.toHaveBeenCalled();
    const row = await getTaskRow(piGrants[0], initial.id);
    expect(row).toMatchObject({ state: TaskState.TASK_STATE_FAILED, nativeOperationId: null, leaseToken: null });
    expect(Task.fromJSON(row.snapshot).status?.message?.parts[0].content?.$case).toBe('text');
  });

  it.each(['completed', 'interrupted'] as const)('ignores a stale worker %s result after a newer claim takes ownership', async (outcome) => {
    const initial = await submitTask(piGrants[0], request());
    const nativeOperationId = randomUUID();
    const entered = Promise.withResolvers<A2ATask>();
    const settle = Promise.withResolvers<void>();
    const execution = execute(initial.id, async (row, signal) => {
      await bindPiHarnessOperation(row.id, row.leaseToken!, nativeOperationId);
      entered.resolve(row);
      await Promise.race([settle.promise, aborted(signal).then((reason) => { throw reason; })]);
      if (outcome === 'interrupted') throw new PiRuntimeInterruptedError();
      return { state: TaskState.TASK_STATE_COMPLETED, nativeOperationId, artifact: textArtifact('Stale result') };
    });
    const old = await Promise.race([entered.promise, execution.then(() => { throw new Error('Executor did not start.'); })]);
    await releasePiHarnessClaim(old.id, old.leaseToken!);
    const current = (await claimTask(old.id))!;
    expect(current.leaseToken).not.toBe(old.leaseToken);
    await checkNativeToolApproval(token(current), { action: 'ready' });
    settle.resolve();
    await execution;
    const owned = await getTaskRow(piGrants[0], initial.id);
    expect(owned).toMatchObject({ state: TaskState.TASK_STATE_WORKING, phase: 'executing', nativeOperationId,
      leaseToken: current.leaseToken, approvalReadyLease: current.leaseToken });
    expect(Task.fromJSON(owned.snapshot).artifacts).toEqual([]);
    await finishTask(current.id, current.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('Current result'), { nativeOperationId });
    expect(Task.fromJSON((await getTaskRow(piGrants[0], initial.id)).snapshot).artifacts[0].parts[0].content).toEqual({ $case: 'text', value: 'Current result' });
  });
});

describe('Pi scheduling stays independent of legacy worker slots', () => {
  it('runs more Pi tasks than the fixed legacy cap while all legacy slots are occupied', async () => {
    const active: A2ATask[] = [];
    for (const authority of [...legacyGrants.slice(0, A2A_LIMITS.workerConcurrency), ...piGrants]) {
      const initial = await submitTask(authority, request());
      const entered = Promise.withResolvers<A2ATask>();
      const execution = execute(initial.id, async (row, signal) => {
        if (row.executionBackend === 'pi-harness') await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
        entered.resolve(row);
        throw await aborted(signal);
      });
      active.push(await Promise.race([entered.promise, execution.then(() => { throw new Error('A free sandbox was blocked by legacy concurrency.'); })]));
    }
    const where = { context: { workspaceId }, state: TaskState.TASK_STATE_WORKING, phase: 'executing' };
    expect(await db.a2ATask.count({ where: { ...where, executionBackend: 'legacy' } })).toBe(A2A_LIMITS.workerConcurrency);
    expect(await db.a2ATask.count({ where: { ...where, executionBackend: 'pi-harness' } })).toBe(A2A_LIMITS.workerConcurrency + 1);
    const queued = await submitTask(legacyGrants[A2A_LIMITS.workerConcurrency], request());
    const executor = vi.fn<TaskExecutor>(async () => ({ state: TaskState.TASK_STATE_COMPLETED, artifact: textArtifact('Legacy result') }));
    await execute(queued.id, executor);
    expect(executor).not.toHaveBeenCalled();
    expect(await getTaskRow(legacyGrants[A2A_LIMITS.workerConcurrency], queued.id)).toMatchObject({ state: TaskState.TASK_STATE_SUBMITTED, phase: 'queued', leaseToken: null });
    stopA2AWorker();
    await Promise.all(executions);
    for (const row of active.filter((task) => task.executionBackend === 'pi-harness')) {
      expect(await db.a2ATask.findUnique({ where: { id: row.id } })).toMatchObject({ state: TaskState.TASK_STATE_WORKING, phase: 'resumable', cancelRequestedAt: null });
    }
    await startWorker();
    await execute(queued.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await getTaskRow(legacyGrants[A2A_LIMITS.workerConcurrency], queued.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it('does not admit a second root through its parent executor inherited sandbox lease', async () => {
    const parent = await submitTask(piGrants[0], request());
    const queued = await submitTask(piGrants[0], request());
    const nested = vi.fn<TaskExecutor>(completed);
    await execute(parent.id, (row) => withSandboxExecutionLease(pi[0].sandboxId, async () => {
      // Same-task host reentry is valid; another task must not inherit its writer lease.
      await execute(queued.id, nested);
      return completed(row);
    }));
    expect(nested).not.toHaveBeenCalled();
    expect((await getTaskRow(piGrants[0], parent.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(await getTaskRow(piGrants[0], queued.id)).toMatchObject({
      state: TaskState.TASK_STATE_SUBMITTED, phase: 'queued', leaseToken: null, nativeOperationId: null,
    });
    await execute(queued.id, nested);
    expect(nested).toHaveBeenCalledTimes(1);
    expect((await getTaskRow(piGrants[0], queued.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it('fails a busy child inside its parent executor but leaves a busy root queued', async () => {
    const parent = await submitTask(piGrants[0], request());
    let authority!: LocalA2AGrant;
    let child!: A2ATask;
    const root = await submitTask(piGrants[1], request());
    const unlocked = Promise.withResolvers<void>();
    const lock = withSandboxExecutionLease(pi[1].sandboxId, () => unlocked.promise);
    const executor = vi.fn<TaskExecutor>(completed);
    try {
      await execute(parent.id, async (row) => {
        await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
        authority = await childGrant(row.id, row.leaseToken!, pi[1].id);
        child = await submitTask(authority, request(), { parentLeaseToken: row.leaseToken! });
        await execute(child.id, executor);
        await execute(root.id, executor);
        return completed(row);
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await getTaskRow(authority, child.id)).toMatchObject({ state: TaskState.TASK_STATE_FAILED, nativeOperationId: null, leaseToken: null });
      expect(await getTaskRow(piGrants[1], root.id)).toMatchObject({ state: TaskState.TASK_STATE_SUBMITTED, phase: 'queued', leaseToken: null });
      expect((await getTaskRow(piGrants[0], parent.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      unlocked.resolve();
      await lock;
    }
    await execute(root.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await getTaskRow(piGrants[1], root.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});
