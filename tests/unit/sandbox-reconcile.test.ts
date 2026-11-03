import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeStaleDockerVolumeCopyHelpers: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  sandboxSnapshotUpdateMany: vi.fn(),
  sandboxFindMany: vi.fn(),
  deploymentUpdate: vi.fn(),
  setDockerSandboxPaused: vi.fn(),
}));

vi.mock("@/lib/sandboxes/runtime", () => ({
  removeStaleDockerVolumeCopyHelpers: mocks.removeStaleDockerVolumeCopyHelpers,
  setDockerSandboxPaused: mocks.setDockerSandboxPaused,
}));

vi.mock("@/lib/db", () => ({
  db: {
    sandbox: { findMany: mocks.sandboxFindMany },
    deployment: {
      updateMany: mocks.deploymentUpdateMany,
      update: mocks.deploymentUpdate,
    },
    sandboxSnapshot: {
      updateMany: mocks.sandboxSnapshotUpdateMany,
    },
  },
}));

import { reconcileSandboxVolumeCopies } from "@/lib/sandboxes/reconcile";

describe("reconcileSandboxVolumeCopies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxFindMany.mockResolvedValue([]);
    mocks.setDockerSandboxPaused.mockResolvedValue(undefined);
  });

  it("removes stale copy helpers before marking interrupted clones", async () => {
    const interruptedBefore = new Date("2026-07-14T03:00:00.000Z");
    mocks.removeStaleDockerVolumeCopyHelpers.mockResolvedValue(2);
    mocks.deploymentUpdateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    mocks.sandboxSnapshotUpdateMany.mockResolvedValue({ count: 2 });

    await expect(
      reconcileSandboxVolumeCopies({ helpersCreatedBefore: interruptedBefore }),
    ).resolves.toEqual({
      helpersRemoved: 2,
      copiesInterrupted: 3,
      restoresInterrupted: 1,
      upgradesInterrupted: 2,
      snapshotsInterrupted: 2,
    });

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "sandbox",
        status: "copying",
        updatedAt: { lte: interruptedBefore },
      },
      data: { status: "copy_failed" },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "sandbox",
        status: { in: ["restoring", "restore_cleanup_required"] },
        updatedAt: { lte: interruptedBefore },
      },
      data: { status: "restore_failed" },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "sandbox",
        status: "upgrading",
        updatedAt: { lte: interruptedBefore },
      },
      data: { status: "error" },
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: { status: "creating", updatedAt: { lte: interruptedBefore } },
      data: { status: "error", error: "Snapshot creation was interrupted." },
    });
    expect(
      mocks.removeStaleDockerVolumeCopyHelpers.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deploymentUpdateMany.mock.invocationCallOrder[0]);
    expect(mocks.removeStaleDockerVolumeCopyHelpers).toHaveBeenCalledWith(
      interruptedBefore,
    );
  });

  it("does not mark copies when helper cleanup cannot be confirmed", async () => {
    mocks.removeStaleDockerVolumeCopyHelpers.mockRejectedValue(
      new Error("docker unavailable"),
    );

    await expect(reconcileSandboxVolumeCopies()).rejects.toThrow(
      "docker unavailable",
    );

    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotUpdateMany).not.toHaveBeenCalled();
  });

  it("retains durable pause intent until source processes are resumed", async () => {
    mocks.sandboxFindMany.mockResolvedValue([
      {
        id: "source",
        deploymentId: "source-deployment",
        deployment: {
          installCfg: {
            volumeName: "source-data",
            agentConversationSnapshotPaused: true,
          },
        },
      },
    ]);
    mocks.setDockerSandboxPaused.mockRejectedValueOnce(
      new Error("unpause unavailable"),
    );
    await expect(reconcileSandboxVolumeCopies()).rejects.toThrow(
      "unpause unavailable",
    );
    expect(mocks.setDockerSandboxPaused).toHaveBeenCalledWith("source", false);
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
  });
});
