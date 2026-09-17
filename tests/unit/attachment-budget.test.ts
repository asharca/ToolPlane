// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: { systemSetting: { findUnique: read } } }));
vi.mock('@/lib/admin/audited-setting', () => ({ saveAuditedSetting: vi.fn() }));
import { reservedUploadBytes, checkAttachmentBudget, boundedUploadStream, attachmentBudget } from '@/lib/agents/upload-budget';
afterEach(() => vi.unstubAllEnvs());
describe('upload reservations use actual bounded bytes', () => {
  it('reserves the full finite limit when the client omits Content-Length', () => expect(reservedUploadBytes(null, 10)).toBe(10));
  it.each(['0', '-1', '1.5', 'nope', '9007199254740992', '11'])('rejects invalid or over-limit lengths %s', (v) => expect(() => reservedUploadBytes(v, 10)).toThrow());
  it('counts completed and pending bytes together before admission', () => {
    const limits = { workspaceBytes: 100, agentBytes: 100, concurrentUploads: 2 };
    expect(() => checkAttachmentBudget({ workspaceUsed: 20, agentUsed: 20, pendingWorkspace: 40, pendingAgent: 40, requested: 50, active: 1 }, limits)).toThrow('quota');
    expect(() => checkAttachmentBudget({ workspaceUsed: 0, agentUsed: 0, pendingWorkspace: 0, pendingAgent: 0, requested: 1, active: 2 }, limits)).toThrow('concurrency');
  });
  it('rejects invalid quota configuration rather than silently disabling it', () => {
    vi.stubEnv('TOOLPLANE_ATTACHMENT_WORKSPACE_BYTES', '-1'); expect(() => attachmentBudget()).toThrow();
  });
  it('aborts before forwarding the first chunk beyond the reserved bytes', async () => {
    const overflow = vi.fn(); const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(4)); c.close(); } });
    const limited = boundedUploadStream(source, 5, overflow); const reader = limited.stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(3); await expect(reader.read()).rejects.toThrow('reserved');
    expect(limited.bytes()).toBe(3); expect(limited.complete()).toBe(false); expect(limited.exceeded()).toBe(true); expect(overflow).toHaveBeenCalledOnce();
  });
  it('records completion only after all bytes were streamed', async () => {
    const limited = boundedUploadStream(new Response('12345').body!, 5, vi.fn());
    expect(limited.complete()).toBe(false); expect(await new Response(limited.stream).text()).toBe('12345');
    expect(limited.bytes()).toBe(5); expect(limited.complete()).toBe(true);
  });
});
describe('all attachment limit sources share the hard clamp', () => {
  it('cold-cache DB failure blocks new uploads', async () => {
    vi.resetModules(); read.mockRejectedValue(new Error('db down'));
    const limits = await import('@/lib/agents/attachment-limits'); await expect(limits.resolveAgentAttachmentLimit()).rejects.toThrow('temporarily unavailable');
  });
  it('retains a stricter last-known-good limit on DB failure', async () => {
    vi.resetModules(); read.mockResolvedValue({ value: '100' }); const limits = await import('@/lib/agents/attachment-limits');
    expect(await limits.resolveAgentAttachmentLimit()).toEqual({ bytes: 100, source: 'database' });
    read.mockRejectedValue(new Error('db down')); vi.stubEnv('TOOLPLANE_MAX_ATTACHMENT_BYTES', '1000000');
    expect(await limits.resolveAgentAttachmentLimit()).toMatchObject({ bytes: 100, cached: true });
  });
  it('clamps DB, environment and default, and rejects malformed hard limits', async () => {
    vi.resetModules(); const limits = await import('@/lib/agents/attachment-limits'); vi.stubEnv('TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES', '200');
    read.mockResolvedValue({ value: '1000' }); expect((await limits.resolveAgentAttachmentLimit()).bytes).toBe(200);
    vi.stubEnv('TOOLPLANE_MAX_ATTACHMENT_BYTES', '1000'); expect(limits.environmentAgentAttachmentLimit().bytes).toBe(200);
    vi.stubEnv('TOOLPLANE_MAX_ATTACHMENT_BYTES', ''); expect(limits.environmentAgentAttachmentLimit().bytes).toBe(200);
    vi.stubEnv('TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES', 'broken'); expect(() => limits.attachmentHardLimit()).toThrow();
  });
});
