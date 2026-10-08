// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), settings: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $transaction: async (fn: (tx: unknown) => unknown) => fn({ logEvent: { create: mocks.create } }) } }));
vi.mock('@/lib/observability/settings', () => ({ getLogSettings: mocks.settings }));
import { recordEvent } from '@/lib/observability/events';
import { withLogContext, enrichLogContext } from '@/lib/observability/context';
import { boundedResponseText, MAX_DIAGNOSTIC_BYTES } from '@/lib/observability/payload';
import { recordA2AEvent } from '@/lib/observability/a2a-log';
import { getLogContext } from '@/lib/observability/context';
import type { LocalA2AGrant } from '@/lib/a2a/principal';

const grant: LocalA2AGrant = { kind: 'local', workspaceId: 'ws', actorId: 'actor', agentId: 'agent',
  targetBinding: 'binding', ownerKey: 'private-owner', expiresAt: Date.now() + 60_000,
  scopes: ['a2a:send'], maxConcurrent: 1, timeoutSeconds: 60, retentionDays: 1,
  ancestorTaskIds: [], ancestorAgentIds: [] };
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
  it('automatically captures bounded redacted deployment MCP detail without a diagnostic window', async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [] });
    await withLogContext({ workspaceId: 'ws', secrets: ['runtime-secret-value'] }, () => recordEvent({
      domain: 'mcp', eventName: 'mcp.rpc', deploymentId: 'deployment-1', rpcMethod: 'tools/call',
      detail: { request: { method: 'tools/call', params: { name: 'echo', arguments: { value: 'runtime-secret-value', apiKey: 'private-key' } } },
        response: { result: { content: [{ type: 'text', text: 'x'.repeat(40_000) }] } } },
    }));
    const detail = mocks.create.mock.calls[0][0].data.detail.create;
    expect(detail.data).toMatchObject({ workspaceMcpPayload: true, payload: { request: {
      method: 'tools/call', params: { name: 'echo', arguments: { value: '[REDACTED]', apiKey: '[REDACTED]' } },
    } } });
    expect(detail.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detail.data))).toBeLessThanOrEqual(32_768);
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('runtime-secret-value');
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('private-key');
  });
  it.each([{ suppressPayload: true }, { agentId: 'agent-1' }])('does not auto-capture deployment MCP payloads in sensitive context %j', async (context) => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [] });
    const detail = vi.fn(() => ({ request: 'private input', response: 'private output' }));
    await withLogContext({ workspaceId: 'ws', ...context }, () => recordEvent({
      domain: 'mcp', eventName: 'mcp.rpc', deploymentId: 'deployment-1', detail,
    }));
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it('marks explicitly captured Agent and workspace API bodies unavailable to workspace request readers', async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [capture(true)] });
    for (const fields of [
      { deploymentId: 'deployment-1', payloadPolicy: 'agent-content' as const },
      { payloadPolicy: 'diagnostic' as const },
    ]) {
      await recordEvent({ workspaceId: 'ws', domain: 'mcp', eventName: 'gateway.request', ...fields,
        detail: { request: 'private input', response: 'private output' },
      });
    }
    for (const [entry] of mocks.create.mock.calls) {
      expect(entry.data.detail.create.data).toMatchObject({ workspaceMcpPayload: false, payload: { request: 'private input' } });
    }
  });
  it('captures authorized request boundaries in a detached span without disabling execution suppression', async () => {
    mocks.settings.mockResolvedValue({ eventDays: 0.5, detailDays: 7, captures: [] });
    await withLogContext({ workspaceId: 'wrong', actorId: 'wrong', suppressPayload: true, secrets: ['fixture-secret'] }, async () => {
      const parent = getLogContext()!;
      await recordA2AEvent({ eventName: 'a2a.request', binding: { grant, taskId: 'task' },
        metadata: { direction: 'inbound', transport: 'jsonrpc', taskId: 'untrusted' }, outcome: 'success',
        request: { text: 'hello fixture-secret password=private' }, responseKind: 'none', responseComplete: true, truncated: true });
      const data = mocks.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ workspaceId: 'ws', actorId: 'actor', agentId: 'agent', traceId: parent.traceId, parentSpanId: parent.spanId,
        attributes: { data: { a2a: { taskId: 'task', rootTaskId: 'task' } } } });
      expect(data.spanId).not.toBe(parent.spanId);
      expect(data.a2a).toBeUndefined();
      expect(data.detail.create).toMatchObject({ truncated: true, data: { workspaceMcpPayload: false,
        payload: { request: { text: 'hello [REDACTED] password="[REDACTED]"' }, responseKind: 'none', responseComplete: true } } });
      expect(data.detail.create.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 43_200_000);
      expect(getLogContext()?.suppressPayload).toBe(true);
      expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('hello');
      expect(JSON.stringify(data)).not.toContain('private-owner');
    });
  });
  it.each(['unbound', 'denied', 'started'] as const)('never evaluates payload readers for %s requests', async (kind) => {
    const reader = vi.fn(() => 'private');
    await recordA2AEvent({ eventName: kind === 'started' ? 'a2a.task.started' : 'a2a.request',
      binding: kind === 'unbound' ? undefined : { grant }, metadata: { direction: 'inbound', transport: 'entry' },
      outcome: kind === 'denied' ? 'denied' : 'success', request: reader, response: reader });
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it('request-response still obeys ordinary parent suppression', async () => {
    const detail = vi.fn();
    await withLogContext({ suppressPayload: true }, () => recordEvent({ ...event, payloadPolicy: 'request-response', detail }));
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it('invalid metadata and throwing projections cannot reject the business operation', async () => {
    await recordA2AEvent({ eventName: 'a2a.request', binding: { grant },
      metadata: { direction: 'inbound', transport: 'entry', rpcErrorCode: Infinity }, outcome: 'error' });
    expect(mocks.create).not.toHaveBeenCalled();
    await recordA2AEvent({ eventName: 'a2a.request', binding: { grant },
      metadata: { direction: 'inbound', transport: 'entry', taskState: 'TASK_STATE_private-prompt' }, outcome: 'error' });
    expect(mocks.create).not.toHaveBeenCalled();
    await recordA2AEvent({ eventName: 'a2a.request', binding: { grant },
      metadata: { direction: 'inbound', transport: 'entry' }, outcome: 'success', request: () => { throw new Error('private'); } });
    expect(mocks.create).not.toHaveBeenCalled();
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
