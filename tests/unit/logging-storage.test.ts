// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const transaction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: { $transaction: transaction } }));
vi.mock('@/lib/observability/settings', () => ({ getLogSettings: async () => ({ eventDays: 30, detailDays: 7, auditDays: 180, captures: [] }) }));
import { logHealth, recordEvent } from '@/lib/observability/events';

afterEach(() => vi.restoreAllMocks());

describe('logging failure isolation', () => {
  it('survives database, serialization and stderr failures without exposing their errors', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    transaction.mockRejectedValue(new Error('database password=never-print-this'));
    const failures = logHealth.failures;
    await expect(recordEvent({ domain: 'system', eventName: 'test.failure' })).resolves.toBeUndefined();
    const attributes = Object.defineProperty({}, 'broken', { enumerable: true, get() { throw new Error('private-getter'); } });
    await expect(recordEvent({ domain: 'system', eventName: 'test.serialization', attributes })).resolves.toBeUndefined();
    expect(logHealth.pending).toBe(0);
    expect(logHealth.failures).toBe(failures + 2);
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/never-print-this|private-getter/);
    output.mockImplementation(() => { throw new Error('closed stderr'); });
    await expect(recordEvent({ domain: 'system', eventName: 'test.stderr' })).resolves.toBeUndefined();
    expect(logHealth.pending).toBe(0);
  });
});
