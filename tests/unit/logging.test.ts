// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { sanitizeLog } from '@/lib/observability/redaction';
import { getLogContext, withLogContext } from '@/lib/observability/context';

const records = vi.hoisted(() => vi.fn());
vi.mock('@/lib/observability/events', () => ({ recordEvent: records }));
import { withRequestLogging } from '@/lib/observability/http';

describe('structured logging safety', () => {
  it('redacts nested credentials, errors and known secrets while retaining usage and valid bounded JSON', () => {
    const error = new Error('Authorization: Bearer fixture-private-value', { cause: new Error('password="do-not-record"') });
    const circular: Record<string, unknown> = { error, apiKey: 'private', inputTokens: 42, outputTokens: 7, headers: { cookie: 'private' }, nested: ['known-value'] };
    circular.self = circular;
    const result = sanitizeLog(circular, ['known-value']);
    const text = JSON.stringify(result.data);
    expect(text).not.toContain('fixture-private-value');
    expect(text).not.toContain('do-not-record');
    expect(text).not.toContain('known-value');
    expect(result.data).toMatchObject({ apiKey: '[REDACTED]', inputTokens: 42, outputTokens: 7 });
    const huge = sanitizeLog({ text: '字'.repeat(50_000), next: ['x'.repeat(1000)] }, [], 512);
    expect(huge.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(huge.data))).toBeLessThanOrEqual(512);
    expect(() => JSON.parse(JSON.stringify(huge.data))).not.toThrow();
  });

  it('isolates concurrent roots and links child spans without leaking non-context fields', async () => {
    const contexts = await Promise.all(['a', 'b'].map(actorId => withLogContext({ actorId }, async () => {
      const root = getLogContext()!;
      await new Promise(resolve => setTimeout(resolve, 2));
      return withLogContext({}, () => ({ root: { ...root }, child: { ...getLogContext()! } }));
    })));
    expect(contexts[0].root.traceId).not.toBe(contexts[1].root.traceId);
    expect(contexts[0].child.actorId).toBe('a');
    expect(contexts[1].child.actorId).toBe('b');
    expect(contexts[0].child.parentSpanId).toBe(contexts[0].root.spanId);
    expect(contexts[0].child.spanId).not.toBe(contexts[0].root.spanId);
    expect(getLogContext()).toBeUndefined();
  });

  it('records early authorization failures and ignores untrusted incoming request IDs', async () => {
    records.mockClear();
    records.mockImplementation(async entry => { expect(getLogContext()?.requestId).not.toBe('spoofed'); return entry; });
    const handler = withRequestLogging('/test/[secret]', async () => new Response(null, { status: 401 }));
    const response = await handler(new Request('http://localhost/test/do-not-log?token=private', { headers: { 'x-request-id': 'spoofed' } }));
    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(records).toHaveBeenCalledWith(expect.objectContaining({ path: '/test/[secret]', httpStatus: 401, outcome: 'denied' }));
    expect(JSON.stringify(records.mock.calls)).not.toContain('do-not-log');
  });

  it('preserves SSE bytes and records completion only when the stream finishes', async () => {
    records.mockReset();
    records.mockResolvedValue(undefined);
    const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ok\n\n')); controller.close(); } });
    const response = await withRequestLogging('/stream', async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }))(new Request('http://localhost/stream'));
    expect(await response.text()).toBe('data: ok\n\n');
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', durationMs: expect.any(Number) }));
  });

  it('records SSE cancellation and stream errors once without replacing the error', async () => {
    records.mockReset();
    records.mockResolvedValue(undefined);
    const cancelled = vi.fn();
    const response = await withRequestLogging('/stream', async () => new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'content-type': 'text/event-stream' },
    }))(new Request('http://localhost/stream'));
    await response.body!.cancel();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'cancelled' }));
    records.mockClear();
    const error = new Error('stream failed');
    const failed = await withRequestLogging('/stream', async () => new Response(new ReadableStream({ start(controller) { controller.error(error); } }), {
      headers: { 'content-type': 'text/event-stream' },
    }))(new Request('http://localhost/stream'));
    await expect(failed.text()).rejects.toBe(error);
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'error', error }));
  });
});
