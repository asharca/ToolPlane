import 'server-only';
import { db } from '@/lib/db';
import { HERMES_ARCHIVE_IMPORT_TIMEOUT_MS } from '@/lib/agents/hermes/archive-limits';
import {
  removeStaleDockerVolumeCopyHelpers,
  removeStaleHermesArchiveImportHelpers,
} from './runtime';

export async function reconcileSandboxVolumeCopies(
  options: { helpersCreatedBefore?: Date } = {},
): Promise<{
  helpersRemoved: number;
  hermesArchiveHelpersRemoved: number;
  copiesInterrupted: number;
  restoresInterrupted: number;
  snapshotsInterrupted: number;
}> {
  const interruptedBefore = options.helpersCreatedBefore ?? new Date();
  const helpersRemoved = await removeStaleDockerVolumeCopyHelpers(
    interruptedBefore,
  );
  const hermesArchiveHelpersRemoved = await removeStaleHermesArchiveImportHelpers(
    interruptedBefore,
    HERMES_ARCHIVE_IMPORT_TIMEOUT_MS,
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
    hermesArchiveHelpersRemoved,
    copiesInterrupted: copies.count,
    restoresInterrupted: restores.count,
    snapshotsInterrupted: snapshots.count,
  };
}
