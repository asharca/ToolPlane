import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForSystemUpdateReady } from '@/components/dashboard/SystemUpdateButton';

describe('SystemUpdateButton restart polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until the restarted runtime reports the target version', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ currentVersion: 'v1.0.0', artifactName: 'toolplane-runtime-linux-amd64.tar.gz' })),
      )
      .mockRejectedValueOnce(new TypeError('service restarting'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ currentVersion: 'v1.0.1', artifactName: 'toolplane-runtime-linux-amd64.tar.gz' })),
      );

    const ready = waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(ready).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/admin/system/update?local=1', expect.objectContaining({ cache: 'no-store' }));
  });

  it('times out when the new version never appears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ currentVersion: 'v1.0.0', artifactName: 'toolplane-runtime-linux-amd64.tar.gz' })),
    );

    const ready = waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      pollIntervalMs: 10,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(30);

    await expect(ready).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
