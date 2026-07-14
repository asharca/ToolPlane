import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeStaleDockerVolumeCopyHelpers: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  sandboxSnapshotUpdateMany: vi.fn(),
}));

vi.mock('@/lib/sandboxes/runtime', () => ({
  removeStaleDockerVolumeCopyHelpers: mocks.removeStaleDockerVolumeCopyHelpers,
}));

vi.mock('@/lib/db', () => ({
  db: {
    deployment: {
      updateMany: mocks.deploymentUpdateMany,
    },
    sandboxSnapshot: {
      updateMany: mocks.sandboxSnapshotUpdateMany,
    },
  },
}));

import { reconcileSandboxVolumeCopies } from '@/lib/sandboxes/reconcile';

describe('reconcileSandboxVolumeCopies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes stale copy helpers before marking interrupted clones', async () => {
    const interruptedBefore = new Date('2026-07-14T03:00:00.000Z');
    mocks.removeStaleDockerVolumeCopyHelpers.mockResolvedValue(2);
    mocks.deploymentUpdateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.sandboxSnapshotUpdateMany.mockResolvedValue({ count: 2 });

    await expect(reconcileSandboxVolumeCopies({ helpersCreatedBefore: interruptedBefore })).resolves.toEqual({
      helpersRemoved: 2,
      copiesInterrupted: 3,
      restoresInterrupted: 1,
      snapshotsInterrupted: 2,
    });

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        source: 'sandbox',
        status: 'copying',
        updatedAt: { lte: interruptedBefore },
      },
      data: { status: 'copy_failed' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        source: 'sandbox',
        status: { in: ['restoring', 'restore_cleanup_required'] },
        updatedAt: { lte: interruptedBefore },
      },
      data: { status: 'restore_failed' },
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: { status: 'creating', updatedAt: { lte: interruptedBefore } },
      data: { status: 'error', error: 'Snapshot creation was interrupted.' },
    });
    expect(mocks.removeStaleDockerVolumeCopyHelpers.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.removeStaleDockerVolumeCopyHelpers).toHaveBeenCalledWith(interruptedBefore);
  });

  it('does not mark copies when helper cleanup cannot be confirmed', async () => {
    mocks.removeStaleDockerVolumeCopyHelpers.mockRejectedValue(new Error('docker unavailable'));

    await expect(reconcileSandboxVolumeCopies()).rejects.toThrow('docker unavailable');

    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotUpdateMany).not.toHaveBeenCalled();
  });
});
