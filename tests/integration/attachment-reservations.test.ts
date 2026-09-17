// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reserveAttachment, commitAttachment, failAttachment, maintainAttachmentUploads } from '@/lib/agents/upload-reservations';
const mocks = vi.hoisted(() => ({ ready: vi.fn(), rpc: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/agents/hermes/runtime', () => ({ acquireHermesRuntimeWriteLease: () => ({ release: mocks.release }), ensureHermesRuntimeReady: mocks.ready }));
vi.mock('@/lib/process/mcp-client', () => ({ mcpRpc: mocks.rpc }));
let workspaceId: string, userId: string, agentId: string, runtimeId: string;
beforeEach(async () => {
  vi.clearAllMocks(); const stamp = randomUUID();
  userId = (await db.user.create({ data: { email: `uploads-${stamp}@test.dev`, passwordHash: 'x' } })).id;
  workspaceId = (await db.workspace.create({ data: { slug: `uploads-${stamp}`, name: 'Uploads', ownerId: userId } })).id;
  agentId = (await db.agent.create({ data: { workspaceId, slug: 'agent', name: 'Agent', runtimeKind: 'hermes' } })).id;
  const deployment = await db.deployment.create({ data: { workspaceId, source: 'sandbox' } });
  const sandbox = await db.sandbox.create({ data: { workspaceId, deploymentId: deployment.id, name: 'Runtime', slug: 'runtime', kind: 'hermes' } });
  runtimeId = (await db.agentRuntime.create({ data: { workspaceId, agentId, sandboxId: sandbox.id, image: 'fixture:v1' } })).id;
  vi.stubEnv('TOOLPLANE_ATTACHMENT_WORKSPACE_BYTES', '100'); vi.stubEnv('TOOLPLANE_ATTACHMENT_AGENT_BYTES', '100'); vi.stubEnv('TOOLPLANE_ATTACHMENT_CONCURRENT_UPLOADS', '2');
  mocks.ready.mockResolvedValue({ port: 1234 }); mocks.rpc.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});
afterEach(async () => { vi.unstubAllEnvs(); await db.workspace.deleteMany({ where: { id: workspaceId } }); await db.user.deleteMany({ where: { id: userId } }); });
function reserve(bytes: number) { const id = randomUUID(); return reserveAttachment({ id, userId, workspaceId, agentId, runtimeId, reservedBytes: bytes, storagePath: `attachments/inbox/${id}-data.bin` }); }
describe('attachment reservation accounting', () => {
  it('reserves before transfer, then settles only actual stored bytes', async () => {
    const pending = await reserve(60); expect(pending.reservedBytes).toBe(60);
    await commitAttachment({ id: pending.id, userId, workspaceId, size: 20, name: 'data.bin', mimeType: 'application/octet-stream', conversationId: null });
    expect(await db.agentUploadReservation.count({ where: { workspaceId } })).toBe(0);
    expect((await db.agentAttachment.aggregate({ where: { workspaceId }, _sum: { size: true } }))._sum.size).toBe(20);
    await expect(reserve(81)).rejects.toThrow('quota'); await expect(reserve(80)).resolves.toBeDefined();
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('serializes real PostgreSQL concurrent admissions under one workspace row lock', async () => {
    const attempts = await Promise.allSettled([reserve(60), reserve(60)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.agentUploadReservation.count({ where: { workspaceId } })).toBe(1);
  });
  it('keeps failed uploads charged until final and temporary file cleanup are confirmed', async () => {
    const pending = await reserve(70); await failAttachment(pending.id);
    await expect(reserve(40)).rejects.toThrow('quota'); expect(await maintainAttachmentUploads()).toBe(0);
    await db.agentUploadReservation.update({ where: { id: pending.id }, data: { expiresAt: new Date(0) } });
    mocks.rpc.mockResolvedValueOnce({ isError: true }); expect(await maintainAttachmentUploads()).toBe(0);
    expect(await db.agentUploadReservation.findUnique({ where: { id: pending.id } })).not.toBeNull();
    expect(await maintainAttachmentUploads()).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(expect.any(String), 'tools/call', { name: 'delete_file', arguments: { path: `${pending.storagePath}.toolplane-upload-${pending.id}`, missingOk: true } });
    await expect(reserve(100)).resolves.toBeDefined();
  });
  it('does not commit an expired or mismatched reservation or foreign conversation', async () => {
    const pending = await reserve(60);
    const input = { id: pending.id, userId, workspaceId, size: 61, name: 'a', mimeType: 'text/plain', conversationId: null };
    await expect(commitAttachment(input)).rejects.toThrow('size mismatch');
    await expect(commitAttachment({ ...input, size: 20, conversationId: 'foreign' })).rejects.toThrow('Conversation');
    expect(await db.agentAttachment.count({ where: { workspaceId } })).toBe(0);
    expect(await db.agentUploadReservation.count({ where: { workspaceId } })).toBe(1);
  });
  it('workspace closure denies settlement instead of making a newly callable resource', async () => {
    const pending = await reserve(60); await db.workspace.update({ where: { id: workspaceId }, data: { status: 'deleting' } });
    await expect(commitAttachment({ id: pending.id, userId, workspaceId, size: 20, name: 'a', mimeType: 'text/plain', conversationId: null })).rejects.toThrow('Workspace');
  });
});
