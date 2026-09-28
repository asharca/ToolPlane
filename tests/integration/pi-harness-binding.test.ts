// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { db } from '@/lib/db';
import { childGrant, createLocalRootGrant } from '@/lib/a2a/local-policy';
import type { LocalA2AGrant } from '@/lib/a2a/principal';
import { bindPiHarnessOperation, claimTask, finishTask, getTaskRow, interruptTask, projectPiHarnessProgress, releasePiHarnessClaim, requestCancellation, submitTask } from '@/lib/a2a/store';
import { textArtifact } from '@/lib/a2a/model';

let workspaceId: string, userId: string, piId: string, legacyId: string;
let grant: LocalA2AGrant, legacyGrant: LocalA2AGrant;
const request = (text = 'Binding fixture') => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
});
async function running(authority = grant) {
  const row = await submitTask(authority, request());
  const claimed = await claimTask(row.id);
  if (!claimed?.leaseToken) throw new Error('Fixture task was not claimed.');
  return claimed;
}

beforeAll(async () => {
  if (process.env.TOOLPLANE_TEST_PGLITE === '1') throw new Error('Native binding checks require real PostgreSQL.');
  const stamp = randomUUID();
  userId = (await db.user.create({ data: { email: `pi-binding-${stamp}@test.invalid`, passwordHash: 'x' } })).id;
  workspaceId = (await db.workspace.create({ data: { slug: `pi-binding-${stamp}`, name: 'Pi binding fixture', ownerId: userId } })).id;
  const provider = await db.modelProvider.create({ data: { workspaceId, name: 'Fixture', format: 'openai',
    baseUrl: 'https://model.test.invalid', apiKey: 'fixture' } });
  for (const runtimeKind of ['pi', 'claude-code']) {
    const deployment = await db.deployment.create({ data: { workspaceId, name: runtimeKind, source: 'config' } });
    const sandbox = await db.sandbox.create({ data: { workspaceId, deploymentId: deployment.id, name: runtimeKind, slug: runtimeKind, kind: 'docker', network: 'isolated' } });
    const agent = await db.agent.create({ data: { workspaceId, name: runtimeKind, slug: runtimeKind, runtimeKind,
      providerId: provider.id, model: 'fixture', a2aInternalEnabled: true, sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
    if (runtimeKind === 'pi') piId = agent.id; else legacyId = agent.id;
  }
  await db.agentSubAgent.create({ data: { parentId: legacyId, childId: piId } });
});
beforeEach(async () => {
  await db.a2AContext.deleteMany({ where: { workspaceId } });
  grant = await createLocalRootGrant(workspaceId, piId, userId);
  legacyGrant = await createLocalRootGrant(workspaceId, legacyId, userId);
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('Pi native operation binding in PostgreSQL', () => {
  it('selects the authorized runtime and leaves receipt dedup and historical backend unchanged', async () => {
    const input = request();
    const row = await submitTask(grant, input);
    expect(row.executionBackend).toBe('pi-harness');
    expect((await submitTask(legacyGrant, request())).executionBackend).toBe('legacy');
    await db.a2ATask.update({ where: { id: row.id }, data: { executionBackend: 'legacy' } });
    expect(await submitTask(grant, input)).toMatchObject({ id: row.id, executionBackend: 'legacy' });
    expect(await db.a2ARequest.count({ where: { taskId: row.id } })).toBe(1);
    const changed = SendMessageRequest.fromJSON(SendMessageRequest.toJSON(input));
    changed.message!.parts[0].content = { $case: 'text', value: 'different content' };
    await expect(submitTask(grant, changed)).rejects.toThrow('different content');
  });

  it('binds once under the current claim and resumes the same operation without synthetic history', async () => {
    const row = await running();
    await expect(bindPiHarnessOperation(row.id, 'wrong', randomUUID())).rejects.toThrow();
    const operationId = randomUUID();
    expect(await bindPiHarnessOperation(row.id, row.leaseToken!, operationId)).toBe(operationId);
    expect(await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID())).toBe(operationId);
    await db.a2ATask.update({ where: { id: row.id }, data: { approvalReadyLease: row.leaseToken } });
    await releasePiHarnessClaim(row.id, 'wrong');
    expect((await getTaskRow(grant, row.id)).leaseToken).toBe(row.leaseToken);
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    expect(await getTaskRow(grant, row.id)).toMatchObject({ state: TaskState.TASK_STATE_WORKING, phase: 'resumable',
      nativeOperationId: operationId, leaseToken: null, approvalReadyLease: null, resumeCount: 0 });
    const claims = await Promise.all([claimTask(row.id), claimTask(row.id)]);
    const resumed = claims.find((claim) => claim !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(resumed.nativeOperationId).toBe(operationId);
    expect(resumed.resumeCount).toBe(0);
    expect(resumed.leaseToken).not.toBe(row.leaseToken);
    expect(Task.fromJSON(resumed.snapshot).history).toEqual(Task.fromJSON(row.snapshot).history);
    await expect(bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID())).rejects.toThrow();
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    expect((await getTaskRow(grant, row.id)).leaseToken).toBe(resumed.leaseToken);
  });

  it('projects bounded native progress without history replay or stale-owner writes', async () => {
    const row = await running();
    const operationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await projectPiHarnessProgress(row.id, row.leaseToken!, operationId, 'x'.repeat(4096));
    const projected = await getTaskRow(grant, row.id);
    const task = Task.fromJSON(projected.snapshot);
    expect(task.status!.message!.parts[0].content).toEqual({ $case: 'text', value: 'x'.repeat(2048) });
    expect(task.history).toEqual(Task.fromJSON(row.snapshot).history);
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    const resumed = (await claimTask(row.id))!;
    await projectPiHarnessProgress(row.id, row.leaseToken!, operationId, 'stale owner');
    await projectPiHarnessProgress(row.id, resumed.leaseToken!, randomUUID(), 'wrong operation');
    expect((await getTaskRow(grant, row.id)).sequence).toBe(resumed.sequence);
  });

  it.each(['cancel', 'deadline'] as const)('keeps native completion authoritative after late %s', async (stop) => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    if (stop === 'cancel') expect((await requestCancellation(grant, row.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    else await db.a2ATask.update({ where: { id: row.id }, data: { deadlineAt: new Date(0) } });
    const resumed = (await claimTask(row.id))!;
    expect(resumed.nativeOperationId).toBe(nativeOperationId);
    await expect(finishTask(row.id, resumed.leaseToken!, TaskState.TASK_STATE_COMPLETED)).rejects.toThrow('bound operation');
    await expect(finishTask(row.id, resumed.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, undefined, { nativeOperationId: randomUUID() })).rejects.toThrow();
    await finishTask(row.id, resumed.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('native result'), { nativeOperationId });
    const result = await getTaskRow(grant, row.id);
    expect(result.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(Task.fromJSON(result.snapshot).artifacts[0].parts[0].content).toEqual({ $case: 'text', value: 'native result' });
  });

  it('projects native abort durably and refuses legacy interruption of a bound operation', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await expect(interruptTask(row.id, 'driver stopped')).rejects.toThrow('natively');
    await requestCancellation(grant, row.id);
    await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_CANCELED, undefined, undefined, { nativeOperationId });
    expect((await getTaskRow(grant, row.id)).state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(await claimTask(row.id)).toBeNull();
  });

  it('does not grant legacy rows native bypass or change legacy cancellation precedence', async () => {
    const row = await running(legacyGrant);
    await expect(bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID())).rejects.toThrow();
    await expect(releasePiHarnessClaim(row.id, row.leaseToken!)).rejects.toThrow();
    await expect(finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, undefined, { nativeOperationId: randomUUID() })).rejects.toThrow();
    await requestCancellation(legacyGrant, row.id);
    await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('must not publish'));
    const result = await getTaskRow(legacyGrant, row.id);
    expect(result.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(Task.fromJSON(result.snapshot).artifacts).toEqual([]);
  });

  it('does not allocate a native operation after cancellation and never falls back for an unknown backend', async () => {
    const row = await running();
    await requestCancellation(grant, row.id);
    await expect(bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID())).rejects.toThrow();
    await releasePiHarnessClaim(row.id, row.leaseToken!);
    expect(await claimTask(row.id)).toBeNull();
    const unknown = await submitTask(grant, request());
    await db.a2ATask.update({ where: { id: unknown.id }, data: { executionBackend: 'unknown' } });
    await expect(claimTask(unknown.id)).rejects.toThrow('backend');
  });

  it('queues descendant native cancellation until the child confirms abort', async () => {
    const parent = await running(legacyGrant);
    const authority = await childGrant(parent.id, parent.leaseToken!, piId);
    const child = await submitTask(authority, request(), { parentLeaseToken: parent.leaseToken! });
    const active = (await claimTask(child.id))!;
    const nativeOperationId = await bindPiHarnessOperation(child.id, active.leaseToken!, randomUUID());
    await releasePiHarnessClaim(child.id, active.leaseToken!);
    await requestCancellation(legacyGrant, parent.id);
    expect(await getTaskRow(authority, child.id)).toMatchObject({ state: TaskState.TASK_STATE_WORKING, cancelRequestedAt: expect.any(Date) });
    const cleanup = (await claimTask(child.id))!;
    await finishTask(child.id, cleanup.leaseToken!, TaskState.TASK_STATE_CANCELED, undefined, undefined, { nativeOperationId });
    expect((await getTaskRow(authority, child.id)).state).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

describe('native projection keeps authorization and approval safety', () => {
  it('bypasses legacy pending-question joins for a confirmed native terminal', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await db.a2ATask.update({ where: { id: row.id }, data: { pendingQuestion: 'Legacy question' } });
    await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('native result'), { nativeOperationId });
    expect(await getTaskRow(grant, row.id)).toMatchObject({ state: TaskState.TASK_STATE_COMPLETED, phase: 'done', pendingQuestion: null });
  });

  it('does not publish success while the current lease has an unresolved approval', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await db.a2AToolApproval.create({ data: { taskId: row.id, leaseToken: row.leaseToken!, callId: randomUUID(),
      toolName: 'write', input: { path: 'fixture' }, inputHash: 'fixture', expiresAt: row.deadlineAt } });
    await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('must not publish'), { nativeOperationId });
    const result = await getTaskRow(grant, row.id);
    expect(result.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(Task.fromJSON(result.snapshot).artifacts).toEqual([]);
  });

  it('keeps a confirmed native abort when a human approval was still pending', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await db.a2AToolApproval.create({ data: { taskId: row.id, leaseToken: row.leaseToken!, callId: randomUUID(),
      toolName: 'write', input: { path: 'fixture' }, inputHash: 'fixture', expiresAt: row.deadlineAt } });
    await requestCancellation(grant, row.id);
    await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_CANCELED, undefined, undefined, { nativeOperationId });
    expect((await getTaskRow(grant, row.id)).state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('records an already settled native result after revocation without authorizing new execution', async () => {
    const row = await running();
    const nativeOperationId = await bindPiHarnessOperation(row.id, row.leaseToken!, randomUUID());
    await db.agent.update({ where: { id: piId }, data: { a2aInternalEnabled: false } });
    try {
      await expect(createLocalRootGrant(grant.workspaceId, piId, grant.actorId)).rejects.toThrow();
      await finishTask(row.id, row.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('committed before revocation'), { nativeOperationId });
      expect((await getTaskRow(grant, row.id)).state).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      await db.agent.update({ where: { id: piId }, data: { a2aInternalEnabled: true } });
    }
  });
});
