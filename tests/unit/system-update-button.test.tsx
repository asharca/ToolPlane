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
        new Response(JSON.stringify({
          runtimeId: 'old-runtime',
          currentVersion: 'v1.0.0',
          artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
          updateJob: { status: 'downloading', targetVersion: 'v1.0.1', message: null },
        })),
      )
      .mockRejectedValueOnce(new TypeError('service restarting'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          runtimeId: 'new-runtime',
          currentVersion: 'v1.0.1',
          artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
          updateJob: { status: 'idle', targetVersion: null, message: null },
        })),
      );

    const ready = waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      previousRuntimeId: 'old-runtime',
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(ready).resolves.toEqual({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/admin/system/update?local=1', expect.objectContaining({ cache: 'no-store' }));
  });

  it('times out when the new version never appears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        runtimeId: 'old-runtime',
        currentVersion: 'v1.0.0',
        artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
        updateJob: { status: 'downloading', targetVersion: 'v1.0.1', message: null },
      })),
    );

    const ready = waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      previousRuntimeId: 'old-runtime',
      pollIntervalMs: 10,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(30);

    await expect(ready).resolves.toEqual({ status: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not mistake an in-place version-file replacement for a completed restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runtimeId: 'same-runtime',
        currentVersion: 'v1.0.1',
        artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
        updateJob: { status: 'restarting', targetVersion: 'v1.0.1', message: null },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runtimeId: 'next-runtime',
        currentVersion: 'v1.0.1',
        artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
        updateJob: { status: 'idle', targetVersion: null, message: null },
      })));

    const ready = waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      previousRuntimeId: 'same-runtime',
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(ready).resolves.toEqual({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a background update failure without waiting for the restart timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runtimeId: 'same-runtime',
      currentVersion: 'v1.0.0',
      artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
      updateJob: { status: 'failed', targetVersion: 'v1.0.1', message: 'Checksum mismatch' },
    })));

    await expect(waitForSystemUpdateReady('v1.0.1', {
      fetchImpl,
      previousRuntimeId: 'same-runtime',
      pollIntervalMs: 10,
      timeoutMs: 100,
    })).resolves.toEqual({ status: 'failed', message: 'Checksum mismatch' });
  });
});
