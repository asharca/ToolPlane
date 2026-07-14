import 'server-only';
import { db } from '@/lib/db';
import { removeStaleDockerVolumeCopyHelpers } from './runtime';

export async function reconcileSandboxVolumeCopies(
  options: { helpersCreatedBefore?: Date } = {},
): Promise<{
  helpersRemoved: number;
  copiesInterrupted: number;
  restoresInterrupted: number;
  snapshotsInterrupted: number;
}> {
  const interruptedBefore = options.helpersCreatedBefore ?? new Date();
  const helpersRemoved = await removeStaleDockerVolumeCopyHelpers(
    interruptedBefore,
  );
  const copies = await db.deployment.updateMany({
    where: {
      source: 'sandbox',
      status: 'copying',
      updatedAt: { lte: interruptedBefore },
    },
    data: { status: 'copy_failed' },
  });
  const restores = await db.deployment.updateMany({
    where: {
      source: 'sandbox',
      status: { in: ['restoring', 'restore_cleanup_required'] },
      updatedAt: { lte: interruptedBefore },
    },
    data: { status: 'restore_failed' },
  });
  const snapshots = await db.sandboxSnapshot.updateMany({
    where: { status: 'creating', updatedAt: { lte: interruptedBefore } },
    data: { status: 'error', error: 'Snapshot creation was interrupted.' },
  });
  return {
    helpersRemoved,
    copiesInterrupted: copies.count,
    restoresInterrupted: restores.count,
    snapshotsInterrupted: snapshots.count,
  };
}
