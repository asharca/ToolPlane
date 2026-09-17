// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeOwnerLease } from '@/lib/runtime/owner';
import { RuntimeOwnershipState, RuntimeUnavailableError, ownership, runtimeRequest, runtimeRequestUnavailable } from '@/lib/runtime/ownership-state';
const OLD = '11111111-1111-4111-8111-111111111111';
class TestConnection extends EventEmitter {
  connect = vi.fn(async () => undefined);
  end = vi.fn(async () => undefined);
  query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT pg_try')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT value')) return { rows: [] as { value: string }[] };
    return { rows: [] };
  });
}
function lease(connection: TestConnection, acknowledge?: string, lost = vi.fn()) {
  return new RuntimeOwnerLease(connection as unknown as ConstructorParameters<typeof RuntimeOwnerLease>[0], 'test-domain', acknowledge, lost);
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); ownership.status = 'idle'; expect(ownership.pending).toBe(0); });
describe('runtime ownership state', () => {
  it('does not serve execution before recovery; maintenance authority is asynchronous-context scoped', async () => {
    const state = new RuntimeOwnershipState();
    expect(() => state.assert()).toThrow(RuntimeUnavailableError);
    state.status = 'recovering';
    await state.maintenance.run(true, async () => { await Promise.resolve(); expect(state.canOperate()).toBe(true); });
    expect(state.canOperate()).toBe(false);
    state.ready(); expect(state.canOperate()).toBe(true);
  });
  it('tracks nested operations and releases counts even on errors', async () => {
    const state = new RuntimeOwnershipState(); state.status = 'ready';
    await expect(state.run(async () => { expect(state.pending).toBe(1); await state.run(async () => { expect(state.pending).toBe(2); }); throw new Error('failed'); })).rejects.toThrow('failed');
    expect(state.pending).toBe(0);
    const release = state.enter(); release(); release(); expect(state.pending).toBe(0);
  });
  it('draining admits only explicit cleanup in maintenance context', async () => {
    const state = new RuntimeOwnershipState(); state.status = 'draining';
    expect(state.canOperate(true)).toBe(false);
    await state.maintenance.run(true, async () => {
      expect(state.canOperate()).toBe(false); expect(state.canOperate(true)).toBe(true);
    });
    expect(await state.drain(1)).toBe(true);
  });
  it('loss cancels requests and blocks even maintenance cleanup with shared resources', async () => {
    const state = new RuntimeOwnershipState(); state.status = 'ready'; state.lose();
    expect(state.abort.signal.aborted).toBe(true);
    state.maintenance.run(true, () => expect(state.canOperate(true)).toBe(false));
    expect(() => state.ready()).toThrow(); expect(await state.drain(1)).toBe(false);
  });
  it('a drain timeout does not pretend external operations have completed', async () => {
    const state = new RuntimeOwnershipState(); state.status = 'ready'; const release = state.enter(); state.status = 'draining';
    expect(await state.drain(1)).toBe(false); expect(state.uncertain).toBe(true);
    expect(state.abort.signal.aborted).toBe(true); release(); expect(await state.drain(1)).toBe(false);
  });
  it('readiness gates mutations while preserving metadata reads and authorized recovery callbacks', async () => {
    vi.stubEnv('TOOLPLANE_TEST_RUNTIME_OWNER', '1'); ownership.status = 'acquiring';
    expect(runtimeRequestUnavailable('/api/v1/agents/[id]/chat', 'POST')).toBe(true);
    expect(runtimeRequestUnavailable('/api/v1/mcp/[id]/terminal/events', 'GET')).toBe(true);
    expect(runtimeRequestUnavailable('/api/v1/mcp/[id]/health', 'GET')).toBe(false);
    ownership.status = 'recovering';
    await runtimeRequest('/api/v1/agent-runtimes/[id]/mcp', 'POST', async () => {
      expect(ownership.pending).toBe(1); expect(ownership.canOperate()).toBe(true);
    });
    expect(ownership.canOperate()).toBe(false);
    ownership.status = 'ready';
    await runtimeRequest('/api/v1/agents/[id]/chat', 'POST', async () => expect(ownership.pending).toBe(1));
  });
});
describe('dedicated PostgreSQL lease protocol (mock connection)', () => {
  it('holds a session lock until its own connection ends, with an exact clean marker delete', async () => {
    const c = new TestConnection(); const l = lease(c); await l.acquire();
    expect(c.query.mock.calls[0][0]).toContain('pg_try_advisory_lock'); expect(c.end).not.toHaveBeenCalled();
    await l.release(true);
    expect(c.query.mock.calls.at(-1)?.[0]).toContain('AND value = $2'); expect(c.end).toHaveBeenCalledOnce();
  });
  it('a competing owner never starts recovery or overwrites the marker', async () => {
    const c = new TestConnection(); c.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const l = lease(c); await expect(l.acquire()).rejects.toThrow('Another ToolPlane'); await l.release(false);
    expect(c.query).toHaveBeenCalledTimes(1); expect(c.end).toHaveBeenCalledOnce();
  });
  it('an unclean marker requires exact operator acknowledgement and is not deleted on failure', async () => {
    const c = new TestConnection(); c.query.mockResolvedValueOnce({ rows: [{ locked: true }] }).mockResolvedValueOnce({ rows: [{ value: OLD }] });
    const l = lease(c); await expect(l.acquire()).rejects.toThrow('TOOLPLANE_RUNTIME_RECOVERY_ACK'); await l.release(false);
    expect(c.query.mock.calls.some(([sql]) => /INSERT|DELETE/.test(sql))).toBe(false);
  });
  it('acknowledgement permits a new owner but uncertain shutdown preserves the new marker', async () => {
    const c = new TestConnection(); c.query.mockResolvedValueOnce({ rows: [{ locked: true }] }).mockResolvedValueOnce({ rows: [{ value: OLD }] });
    const l = lease(c, OLD); await l.acquire(); await l.release(false);
    expect(c.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(true);
    expect(c.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
  });
  it('connection loss invokes fail-closed handling; intentional release does not', async () => {
    const c = new TestConnection(); const lost = vi.fn(); const l = lease(c, undefined, lost);
    await l.acquire(); c.emit('error', new Error('lost')); expect(lost).toHaveBeenCalledOnce();
    await l.release(false); c.emit('end'); expect(lost).toHaveBeenCalledOnce();
  });
  it('periodically checks the dedicated connection and fails closed on a probe error', async () => {
    vi.useFakeTimers();
    const c = new TestConnection(); const lost = vi.fn(); const l = lease(c, undefined, lost);
    await l.acquire();
    c.query.mockRejectedValueOnce(new Error('probe timeout'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.query.mock.calls.at(-1)?.[0]).toBe('SELECT 1');
    expect(lost).toHaveBeenCalledOnce();
    const calls = c.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.query).toHaveBeenCalledTimes(calls);
    await l.release(false); c.emit('end'); expect(lost).toHaveBeenCalledOnce();
  });

});
