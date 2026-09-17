// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), settings: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $transaction: async (fn: (tx: unknown) => unknown) => fn({ logEvent: { create: mocks.create } }) } }));
vi.mock('@/lib/observability/settings', () => ({ getLogSettings: mocks.settings }));
import { recordEvent } from '@/lib/observability/events';
import { withLogContext, enrichLogContext } from '@/lib/observability/context';
import { boundedResponseText, MAX_DIAGNOSTIC_BYTES } from '@/lib/observability/payload';
const capture = (includeAgentContent = false) => ({ field: 'workspaceId', id: 'ws', expiresAt: new Date(Date.now() + 60_000).toISOString(), includeAgentContent });
beforeEach(() => { vi.clearAllMocks(); mocks.settings.mockResolvedValue({ eventDays: 30, detailDays: 7, auditDays: 180, captures: [capture()] }); vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());
const event = { domain: 'agent' as const, workspaceId: 'ws', eventName: 'test.call' };
describe('typed lazy payload policy', () => {
  it('metadata-only is the default even during diagnostic capture', async () => {
    const detail = vi.fn(() => ({ text: 'private' })); await recordEvent({ ...event, detail });
    expect(detail).not.toHaveBeenCalled(); expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it('Agent errors never serialize business text through the default metadata policy', async () => {
    await recordEvent({ ...event, error: new Error('private reply inside an SDK error'), attributes: { text: 'private reply', inputTokens: 3, outputTokens: 4, firstOutputMs: 9 } });
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('private reply');
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('private reply');
    expect(mocks.create.mock.calls[0][0].data.attributes.data).toEqual({ inputTokens: 3, outputTokens: 4, firstOutputMs: 9 });
  });
  it('diagnostic capture alone cannot collect agent content', async () => {
    const detail = vi.fn(() => ({ text: 'private' })); await recordEvent({ ...event, payloadPolicy: 'agent-content', detail });
    expect(detail).not.toHaveBeenCalled(); expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it('explicit agent capture is bounded in lifetime and does not emit payloads to stderr', async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [capture(true)] });
    const detail = vi.fn(() => ({ text: 'business-private', apiKey: 'secret-api-key' }));
    await recordEvent({ ...event, payloadPolicy: 'agent-content', detail, secrets: ['secret-api-key'] });
    expect(detail).toHaveBeenCalledOnce(); const data = mocks.create.mock.calls[0][0].data;
    expect(JSON.stringify(data.detail.create.data)).toContain('business-private');
    expect(JSON.stringify(data)).not.toContain('secret-api-key');
    expect(data.detail.create.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 86400_000);
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('business-private');
  });
  it.each(['forbidden', 'agent-content'] as const)('parent suppression cannot be overridden by a child for %s', async (payloadPolicy) => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [capture(true)] }); const detail = vi.fn(() => ({ text: 'private' }));
    await withLogContext({ workspaceId: 'ws', suppressPayload: true }, () => withLogContext({ suppressPayload: false }, async () => {
      enrichLogContext({ suppressPayload: false });
      await recordEvent({ ...event, payloadPolicy, detail, suppressPayload: false, error: new Error('private error content'), attributes: { text: 'private' } });
    }));
    expect(detail).not.toHaveBeenCalled(); expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('private error content');
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('private');
  });
  it('expired or wrong-resource capture never calls the payload factory', async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [{ ...capture(true), id: 'another' }, { ...capture(true), expiresAt: new Date(0).toISOString() }] });
    const detail = vi.fn(); await recordEvent({ ...event, payloadPolicy: 'agent-content', detail }); expect(detail).not.toHaveBeenCalled();
  });
  it('forbidden overrides even an explicit content capture', async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [capture(true)] }); const detail = vi.fn();
    await recordEvent({ ...event, payloadPolicy: 'forbidden', detail, error: new Error('private prompt') });
    expect(detail).not.toHaveBeenCalled(); expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('private prompt');
  });
});
describe('bounded diagnostic response reader', () => {
  it('does not consume the original response', async () => {
    const response = Response.json({ hello: 'world' }); expect(await boundedResponseText(response)).toContain('world');
    expect(await response.json()).toEqual({ hello: 'world' });
  });
  it('rejects oversized payloads before concatenating them', async () => {
    expect(await boundedResponseText(new Response(new Uint8Array(MAX_DIAGNOSTIC_BYTES + 1)))).toBeNull();
  });
  it('never reads a live SSE stream', async () => {
    const pull = vi.fn(); const response = new Response(new ReadableStream({ pull }), { headers: { 'content-type': 'text/event-stream' } });
    const clone = vi.spyOn(response, 'clone'); expect(await boundedResponseText(response)).toBeNull(); expect(clone).not.toHaveBeenCalled();
  });
});
