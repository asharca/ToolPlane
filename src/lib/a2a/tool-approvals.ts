import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma, type A2ATask } from '@prisma/client';
import { Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { z } from 'zod';
import { db } from '@/lib/db';
import { writeAudit } from '@/lib/observability/audit';
import type { AgentRuntimeTokenPayload } from '@/lib/agents/runtime-access';
import { assertLocalRuntimeToken } from './local-runtime';
import { assertLocalGrant } from './local-policy';
import { isLocalGrant, type TaskGrant } from './principal';
import { lockTask, persist } from './store';
import { agentMessage, statusEvent } from './model';
import { refreshTaskStorage } from './quotas';
import { getConsoleTaskTree } from './console-tasks';
import type { ConsoleActor } from './console-service';

type Tx = Prisma.TransactionClient;
export const NativeApprovalRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ready') }).strict(),
  z.object({ action: z.literal('check'), callId: z.string().min(1).max(200), toolName: z.string().min(1).max(200), input: z.json() }).strict(),
]);
export const NativeApprovalDecision = z.object({ rootTaskId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200), approvalId: z.string().min(1).max(200),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approved', 'denied']) }).strict();
export const APPROVAL_LIMITS = { calls: 32, inputBytes: 16_384, waitMs: 300_000 } as const;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function nativeApprovalHash(toolName: string, input: unknown) {
  const payload = JSON.stringify([toolName, canonical(input)]);
  if (Buffer.byteLength(payload) > APPROVAL_LIMITS.inputBytes) throw new RequestMalformedError('Tool input exceeds the approval display limit.');
  return createHash('sha256').update(payload).digest('hex');
}
async function live(tx: Tx, id: string, lease: string) {
  const row = await lockTask(tx, id);
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant) || row.leaseToken !== lease || row.phase !== 'executing' || row.cancelRequestedAt
    || row.deadlineAt <= new Date() || row.state !== TaskState.TASK_STATE_WORKING) throw new TaskNotFoundError();
  await assertLocalGrant(grant, tx);
  return { row, grant };
}
async function recordWaiting(tx: Tx, row: A2ATask) {
  const task = Task.fromJSON(row.snapshot);
  task.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(),
    message: agentMessage(task, 'A native tool is awaiting a human decision in the console.') };
  // Parameter data is only returned through the initiating user's private console endpoint.
  await persist(tx, row, task, statusEvent(task));
}
/** Polling never grants a second execution: approval consumption is atomic and lease-bound. */
export async function checkNativeToolApproval(token: AgentRuntimeTokenPayload, input: z.infer<typeof NativeApprovalRequest>) {
  if (!token.a2aApprovalRequired) throw new TaskNotFoundError();
  await assertLocalRuntimeToken(token, true);
  return db.$transaction(async (tx) => {
    const { row } = await live(tx, token.a2aTaskId!, token.a2aLeaseToken!);
    if (input.action === 'ready') {
      await tx.a2ATask.update({ where: { id: row.id }, data: { approvalReadyLease: row.leaseToken } });
      return { status: 'ready' as const };
    }
    if (row.approvalReadyLease !== row.leaseToken) throw new TaskNotFoundError();
    const inputHash = nativeApprovalHash(input.toolName, input.input);
    let approval = await tx.a2AToolApproval.findUnique({ where: { taskId_leaseToken_callId: {
      taskId: row.id, leaseToken: row.leaseToken!, callId: input.callId,
    } } });
    if (approval && (approval.inputHash !== inputHash || approval.toolName !== input.toolName)) throw new RequestMalformedError('A tool call ID cannot be reused with changed arguments.');
    const created = !approval;
    if (!approval) {
      if (await tx.a2AToolApproval.count({ where: { taskId: row.id } }) >= APPROVAL_LIMITS.calls) throw new UnsupportedOperationError('Native tool approval limit reached.');
      approval = await tx.a2AToolApproval.create({ data: { taskId: row.id, leaseToken: row.leaseToken!,
        callId: input.callId, toolName: input.toolName, input: input.input === null ? Prisma.JsonNull : input.input as Prisma.InputJsonValue, inputHash,
        expiresAt: new Date(Math.min(row.deadlineAt.getTime(), Date.now() + APPROVAL_LIMITS.waitMs)) } });
    }
    if (approval.expiresAt <= new Date() && ['pending', 'approved'].includes(approval.status)) {
      approval = await tx.a2AToolApproval.update({ where: { id: approval.id }, data: { status: 'expired' } });
    }
    let status: 'pending' | 'allow' | 'deny' = 'deny';
    if (approval.status === 'approved') {
      await tx.a2AToolApproval.update({ where: { id: approval.id }, data: { status: 'consumed', consumedAt: new Date() } });
      status = 'allow';
    } else if (approval.status === 'pending') status = 'pending';
    if (created) await recordWaiting(tx, row);
    else await refreshTaskStorage(tx, row.id);
    return { status, approvalId: approval.id, inputHash, expiresAt: approval.expiresAt.toISOString() };
  });
}
export async function listNativeToolApprovals(ctx: ConsoleActor, rootTaskId: string, taskId: string) {
  await getConsoleTaskTree(ctx, rootTaskId, taskId);
  return db.$transaction(async (tx) => {
    const row = await tx.a2ATask.findUniqueOrThrow({ where: { id: taskId } });
    if (!row.leaseToken || row.phase !== 'executing') return [];
    const { grant } = await live(tx, taskId, row.leaseToken);
    if (grant.actorId !== ctx.actorId || grant.workspaceId !== ctx.workspaceId || row.rootTaskId !== rootTaskId) throw new TaskNotFoundError();
    return tx.a2AToolApproval.findMany({ where: { taskId, leaseToken: row.leaseToken }, orderBy: { createdAt: 'asc' }, take: APPROVAL_LIMITS.calls,
      select: { id: true, taskId: true, toolName: true, input: true, inputHash: true, status: true, createdAt: true, expiresAt: true } });
  });
}
/** Only the authenticated initiating user can decide; model/runtime messages cannot approve. */
export async function decideNativeToolApproval(ctx: ConsoleActor, input: z.infer<typeof NativeApprovalDecision>) {
  await getConsoleTaskTree(ctx, input.rootTaskId, input.taskId);
  return db.$transaction(async (tx) => {
    const initial = await tx.a2AToolApproval.findFirst({ where: { id: input.approvalId, taskId: input.taskId } });
    if (!initial) throw new TaskNotFoundError();
    const { row, grant } = await live(tx, initial.taskId, initial.leaseToken);
    if (grant.actorId !== ctx.actorId || grant.workspaceId !== ctx.workspaceId
      || row.rootTaskId !== input.rootTaskId || initial.inputHash !== input.inputHash) throw new TaskNotFoundError();
    const current = await tx.a2AToolApproval.findUniqueOrThrow({ where: { id: initial.id } });
    if (current.expiresAt <= new Date()) throw new UnsupportedOperationError('The approval expired. No permission was granted.');
    if (current.status === input.decision) return { status: current.status };
    if (current.status !== 'pending') throw new UnsupportedOperationError('This approval was already decided or consumed.');
    await tx.a2AToolApproval.update({ where: { id: current.id }, data: { status: input.decision, decidedBy: ctx.actorId, decidedAt: new Date() } });
    await writeAudit(tx, { actorId: ctx.actorId, workspaceId: ctx.workspaceId, action: 'agent.a2a.tool_approval', targetType: 'A2ATask', targetId: row.id,
      changes: { approvalId: current.id, inputHash: current.inputHash, decision: input.decision } });
    return { status: input.decision };
  });
}
