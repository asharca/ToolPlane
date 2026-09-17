import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { AttachmentAdmissionError, checkAttachmentBudget } from './upload-budget';

const UPLOAD_LEASE_MS = 30 * 60_000; // Greater than the bounded 15-minute upload.
async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string, userId?: string) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
  const allowed = await tx.workspace.findFirst({ where: { id: workspaceId, status: 'active',
    ...(userId ? { OR: [{ ownerId: userId }, { members: { some: { userId } } }] } : {}),
  }, select: { id: true } });
  if (!allowed) throw new AttachmentAdmissionError('Workspace is unavailable.', 403);
}
export async function reserveAttachment(input: {
  id: string; workspaceId: string; agentId: string; runtimeId: string; storagePath: string; reservedBytes: number; userId: string;
}) {
  const { userId, ...data } = input;
  return db.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId, userId);
    const runtime = await tx.agentRuntime.findFirst({ where: { id: input.runtimeId, agentId: input.agentId, workspaceId: input.workspaceId, kind: 'hermes' }, select: { id: true } });
    if (!runtime) throw new AttachmentAdmissionError('Runtime is unavailable.', 404);
    const [workspace, agent, pending, pendingAgent, active] = await Promise.all([
      tx.agentAttachment.aggregate({ where: { workspaceId: input.workspaceId }, _sum: { size: true } }),
      tx.agentAttachment.aggregate({ where: { workspaceId: input.workspaceId, agentId: input.agentId }, _sum: { size: true } }),
      tx.agentUploadReservation.aggregate({ where: { workspaceId: input.workspaceId }, _sum: { reservedBytes: true } }),
      tx.agentUploadReservation.aggregate({ where: { workspaceId: input.workspaceId, agentId: input.agentId }, _sum: { reservedBytes: true } }),
      tx.agentUploadReservation.count({ where: { workspaceId: input.workspaceId, status: 'uploading', expiresAt: { gt: new Date() } } }),
    ]);
    // Expired/failed uploads remain charged until physical cleanup is confirmed.
    checkAttachmentBudget({ workspaceUsed: workspace._sum.size ?? 0, agentUsed: agent._sum.size ?? 0,
      pendingWorkspace: pending._sum.reservedBytes ?? 0, pendingAgent: pendingAgent._sum.reservedBytes ?? 0,
      active, requested: input.reservedBytes });
    return tx.agentUploadReservation.create({ data: { ...data, expiresAt: new Date(Date.now() + UPLOAD_LEASE_MS) } });
  });
}
export async function commitAttachment(input: {
  id: string; userId: string; workspaceId: string; size: number; name: string; mimeType: string; conversationId: string | null;
}) {
  return db.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId, input.userId);
    const reservation = await tx.agentUploadReservation.findFirst({ where: {
      id: input.id, workspaceId: input.workspaceId, status: 'uploading', expiresAt: { gt: new Date() },
    } });
    if (!reservation || input.size <= 0 || input.size > reservation.reservedBytes) throw new AttachmentAdmissionError('Upload reservation expired or size mismatch.');
    if (input.conversationId && !await tx.conversation.findFirst({ where: { id: input.conversationId, agentId: reservation.agentId }, select: { id: true } })) {
      throw new AttachmentAdmissionError('Conversation is unavailable.', 404);
    }
    const attachment = await tx.agentAttachment.create({ data: {
      workspaceId: input.workspaceId, agentId: reservation.agentId, runtimeId: reservation.runtimeId,
      conversationId: input.conversationId, name: input.name, mimeType: input.mimeType, size: input.size,
      storage: 'hermes-volume', storagePath: `/opt/data/workspace/${reservation.storagePath}`,
    } });
    await tx.agentUploadReservation.delete({ where: { id: reservation.id } });
    return attachment;
  });
}
export async function failAttachment(id: string): Promise<void> {
  // Keep the grace deadline: aborting HTTP does not prove Docker has stopped writing.
  await db.agentUploadReservation.updateMany({ where: { id }, data: { status: 'cleanup_required' } });
}
export async function maintainAttachmentUploads() {
  const rows = await db.agentUploadReservation.findMany({ where: { expiresAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 25 });
  let cleaned = 0;
  for (const row of rows) {
    try {
      if (!/^attachments\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}-[A-Za-z0-9._-]+$/.test(row.storagePath) || !/^[a-f0-9-]{36}$/.test(row.id)) continue;
      const runtime = await db.agentRuntime.findFirst({ where: { id: row.runtimeId, agentId: row.agentId, workspaceId: row.workspaceId, kind: 'hermes' }, include: { sandbox: true } });
      if (!runtime) continue; // Only workspace/runtime lifecycle can prove a missing volume was removed.
      const { acquireHermesRuntimeWriteLease, ensureHermesRuntimeReady } = await import('./hermes/runtime');
      const lease = acquireHermesRuntimeWriteLease(row.workspaceId, row.agentId);
      if (!lease) continue;
      try {
        const ready = await ensureHermesRuntimeReady(row.workspaceId, row.agentId, { writeLease: lease });
        if (!ready.port) continue;
        const { mcpRpc } = await import('@/lib/process/mcp-client');
        for (const path of [row.storagePath, `${row.storagePath}.toolplane-upload-${row.id}`]) {
          const result = await mcpRpc(runtime.sandbox.deploymentId, 'tools/call', { name: 'delete_file', arguments: { path, missingOk: true } });
          if (!result || result.isError) throw new Error('Cleanup not confirmed');
        }
        await db.$transaction(async (tx) => {
          await lockWorkspace(tx, row.workspaceId);
          await tx.agentUploadReservation.deleteMany({ where: { id: row.id, expiresAt: { lte: new Date() } } });
        });
        cleaned += 1;
      } finally { lease.release(); }
    } catch { /* Retry without releasing the charged bytes on uncertain cleanup. */ }
  }
  return cleaned;
}
