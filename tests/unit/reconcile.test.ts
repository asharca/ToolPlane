import { describe, it, expect, vi } from 'vitest';
import { reconcileDeployments, type ReconcileDeps } from '@/lib/process/reconcile';

describe('reconcileDeployments', () => {
  it('re-spawns each running deployment with its resolved spec', async () => {
    const start = vi.fn<ReconcileDeps['start']>(async () => {});
    const n = await reconcileDeployments({
      loadRunning: async () => [
        { id: 'a', serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null, installCfg: null },
        { id: 'b', serverId: null, server: null, name: 'Custom', source: 'npm', sourceRef: 'pkg', installCfg: null },
      ],
      start,
    });
    expect(n).toBe(2);
    expect(start.mock.calls[0]).toEqual(['a', { kind: 'builtin', name: 'Stripe' }]);
    expect(start.mock.calls[1][0]).toBe('b');
    expect(start.mock.calls[1][1]).toMatchObject({ kind: 'bridge', command: 'npx' });
  });

  it('keeps going when one deployment fails to start', async () => {
    const start = vi.fn<ReconcileDeps['start']>(async (id) => {
      if (id === 'bad') throw new Error('spawn failed');
    });
    const n = await reconcileDeployments({
      loadRunning: async () => [
        { id: 'bad', serverId: 's', server: { name: 'X' }, name: null, source: null, sourceRef: null, installCfg: null },
        { id: 'ok', serverId: 's2', server: { name: 'Y' }, name: null, source: null, sourceRef: null, installCfg: null },
      ],
      start,
    });
    expect(n).toBe(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when nothing is running', async () => {
    const start = vi.fn<ReconcileDeps['start']>(async () => {});
    expect(await reconcileDeployments({ loadRunning: async () => [], start })).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
});
