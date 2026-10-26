import "server-only";
import { db } from "@/lib/db";
import {
  removeStaleDockerVolumeCopyHelpers,
  setDockerSandboxPaused,
} from "./runtime";

export async function reconcileSandboxVolumeCopies(
  options: { helpersCreatedBefore?: Date } = {},
): Promise<{
  helpersRemoved: number;
  copiesInterrupted: number;
  restoresInterrupted: number;
  upgradesInterrupted: number;
  snapshotsInterrupted: number;
}> {
  const interruptedBefore = options.helpersCreatedBefore ?? new Date();
  const pausedSources = await db.sandbox.findMany({
    where: {
      deployment: {
        installCfg: { path: ["agentConversationSnapshotPaused"], equals: true },
      },
    },
    include: { deployment: true },
  });
  for (const source of pausedSources) {
    await setDockerSandboxPaused(source.id, false);
    const cfg = {
      ...(source.deployment.installCfg as Record<
        string,
        string | number | boolean | null
      >),
    };
    delete cfg.agentConversationSnapshotPaused;
    await db.deployment.update({
      where: { id: source.deploymentId },
      data: { installCfg: cfg },
    });
  }
  const helpersRemoved =
    await removeStaleDockerVolumeCopyHelpers(interruptedBefore);
  const copies = await db.deployment.updateMany({
    where: {
      source: "sandbox",
      status: "copying",
      updatedAt: { lte: interruptedBefore },
    },
    data: { status: "copy_failed" },
  });
  const restores = await db.deployment.updateMany({
    where: {
      source: "sandbox",
      status: { in: ["restoring", "restore_cleanup_required"] },
      updatedAt: { lte: interruptedBefore },
    },
    data: { status: "restore_failed" },
  });
  // Image upgrades intentionally use a durable maintenance status while the
  // old container is removed and the new image is projected. A process crash
  // in that window must not leave the runtime permanently blocked: a later
  // Sync / upgrade can safely rebuild it because the named volume survives
  // and the upgrade invalidates its config hash.
  const upgrades = await db.deployment.updateMany({
    where: {
      source: "sandbox",
      status: "upgrading",
      updatedAt: { lte: interruptedBefore },
    },
    data: { status: "error" },
  });
  const snapshots = await db.sandboxSnapshot.updateMany({
    where: { status: "creating", updatedAt: { lte: interruptedBefore } },
    data: { status: "error", error: "Snapshot creation was interrupted." },
  });
  return {
    helpersRemoved,
    copiesInterrupted: copies.count,
    restoresInterrupted: restores.count,
    upgradesInterrupted: upgrades.count,
    snapshotsInterrupted: snapshots.count,
  };
}
