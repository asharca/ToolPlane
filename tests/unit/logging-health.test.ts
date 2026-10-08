// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(), domains: vi.fn(), deployments: vi.fn(), statuses: vi.fn(),
  writer: { failures: 0, dropped: 0 },
}));
vi.mock('@/lib/db', () => ({ db: {
  user: { findUnique: mocks.user }, $queryRaw: mocks.domains,
  deployment: { findMany: mocks.deployments },
} }));
vi.mock('@/lib/observability/events', () => ({ logHealth: mocks.writer }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatuses: mocks.statuses }));
import { getLogHealth } from '@/lib/observability/health';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ role: 'admin', status: 'active' });
  mocks.domains.mockResolvedValue([]);
  mocks.deployments.mockResolvedValue([]);
  mocks.statuses.mockReturnValue(new Map());
  mocks.writer.failures = 0;
  mocks.writer.dropped = 0;
});

it('does not claim health when no events are available', async () => {
  expect((await getLogHealth('admin')).state).toBe('unknown');
});

it('distinguishes stale active processes from intentionally stopped deployments', async () => {
  mocks.deployments.mockResolvedValue([
    { id: 'stale', name: 'Stale', status: 'running' },
    { id: 'stopped', name: 'Stopped', status: 'stopped' },
    { id: 'failed', name: 'Failed', status: 'error' },
  ]);
  mocks.statuses.mockReturnValue(new Map([['stale', 'stopped'], ['stopped', 'stopped'], ['failed', 'error']]));
  const health = await getLogHealth('admin');
  expect(health.state).toBe('attention');
  expect(health.abnormal.map(row => row.id)).toEqual(['stale', 'failed']);
});

it('keeps rejected requests separate from failures but flags lost diagnostics', async () => {
  mocks.domains.mockResolvedValue([{ domain: 'http', total: 4, errors: 0, denied: 4, last: new Date() }]);
  expect((await getLogHealth('admin')).state).toBe('observed');
  mocks.writer.dropped = 1;
  expect((await getLogHealth('admin')).state).toBe('attention');
  mocks.writer.dropped = 0;
  mocks.domains.mockResolvedValue([{ domain: 'agent', total: 1, errors: 1, denied: 0, last: new Date() }]);
  expect((await getLogHealth('admin')).state).toBe('attention');
});

it.each([null, { role: 'user', status: 'active' }, { role: 'admin', status: 'suspended' }])('denies global health to unauthorized users: %j', async (user) => {
  mocks.user.mockResolvedValue(user);
  await expect(getLogHealth('user')).rejects.toThrow('Forbidden');
  expect(mocks.domains).not.toHaveBeenCalled();
  expect(mocks.deployments).not.toHaveBeenCalled();
});
