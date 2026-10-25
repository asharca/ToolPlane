import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentRuntimeFindFirst: vi.fn(),
  agentRuntimeUpdateMany: vi.fn(),
  sandboxUpdateMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  transaction: vi.fn(),
  agentCreate: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpdate: vi.fn(),
  sandboxCreate: vi.fn(),
  agentRuntimeCreate: vi.fn(),
  deleteAgent: vi.fn(),
  cleanupHermesRuntime: vi.fn(),
  copyHermesArchiveToVolume: vi.fn(),
  resolveHermesImage: vi.fn(),
  beginWorkspaceOperation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    agent: { create: mocks.agentCreate },
    agentRuntime: {
      create: mocks.agentRuntimeCreate,
      findFirst: mocks.agentRuntimeFindFirst,
      updateMany: mocks.agentRuntimeUpdateMany,
    },
    sandbox: {
      create: mocks.sandboxCreate,
      updateMany: mocks.sandboxUpdateMany,
    },
    deployment: {
      create: mocks.deploymentCreate,
      update: mocks.deploymentUpdate,
      updateMany: mocks.deploymentUpdateMany,
    },
  },
}));
vi.mock("@/lib/agents/mutations", () => ({
  deleteAgent: mocks.deleteAgent,
}));
vi.mock("@/lib/agents/hermes/constants", () => ({
  resolveHermesImage: mocks.resolveHermesImage,
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  cleanupHermesRuntime: mocks.cleanupHermesRuntime,
}));
vi.mock("@/lib/agents/hermes/archive-storage", () => ({
  copyHermesArchiveToVolume: mocks.copyHermesArchiveToVolume,
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: mocks.beginWorkspaceOperation,
}));

import { importStagedHermesArchive } from "@/lib/agents/hermes/import";

function stagedArchive() {
  return {
    directory: "/tmp/staged-hermes-home",
    fileCount: 1,
    unpackedBytes: 10,
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe("importStagedHermesArchive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveHermesImage.mockReturnValue("nousresearch/hermes-agent:test");
    mocks.beginWorkspaceOperation.mockReturnValue(vi.fn());
    mocks.agentCreate.mockResolvedValue({
      id: "agent-1",
      name: "Recovered assistant",
    });
    mocks.deploymentCreate.mockResolvedValue({ id: "deployment-1" });
    mocks.sandboxCreate.mockResolvedValue({ id: "sandbox-1" });
    mocks.agentRuntimeCreate.mockResolvedValue({ id: "runtime-1" });
    mocks.transaction.mockImplementation(async (operation) =>
      operation({
        agent: { create: mocks.agentCreate },
        deployment: {
          create: mocks.deploymentCreate,
          update: mocks.deploymentUpdate,
        },
        sandbox: { create: mocks.sandboxCreate },
        agentRuntime: { create: mocks.agentRuntimeCreate },
      }),
    );
    mocks.cleanupHermesRuntime.mockResolvedValue(true);
    mocks.agentRuntimeFindFirst.mockResolvedValue({ sandboxId: "sandbox-1" });
    mocks.agentRuntimeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.sandboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.copyHermesArchiveToVolume.mockResolvedValue(undefined);
  });

  it("creates retired readonly history and imports its files without starting a runtime", async () => {
    await expect(
      importStagedHermesArchive({
        workspaceId: "workspace-1",
        name: "Recovered assistant",
        staged: stagedArchive(),
      }),
    ).resolves.toEqual({ agentId: "agent-1", sandboxId: "sandbox-1" });

    expect(mocks.agentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        name: "Recovered assistant",
        runtimeKind: "hermes",
        retiredAt: expect.any(Date),
      }),
    });
    expect(mocks.agentRuntimeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "stopped" }),
    });
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        network: "none",
        config: {
          managedBy: "historical-archive",
          importSource: "hermes-archive",
          readOnly: true,
        },
      }),
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        sandbox: { is: { id: "sandbox-1", workspaceId: "workspace-1" } },
        source: "sandbox",
      },
      data: { status: "copying" },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { agentId: "agent-1", workspaceId: "workspace-1", kind: "hermes" },
      data: { status: "copying", lastError: null },
    });
    expect(mocks.copyHermesArchiveToVolume).toHaveBeenCalledWith({
      directory: "/tmp/staged-hermes-home",
      image: "nousresearch/hermes-agent:test",
      sandboxId: "sandbox-1",
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        sandbox: { is: { id: "sandbox-1", workspaceId: "workspace-1" } },
        source: "sandbox",
      },
      data: { status: "stopped" },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { agentId: "agent-1", workspaceId: "workspace-1", kind: "hermes" },
      data: { status: "stopped", lastError: null },
    });
  });

  it("cleans staged files without creating history when the workspace is being deleted", async () => {
    const staged = stagedArchive();
    mocks.beginWorkspaceOperation.mockReturnValue(null);
    await expect(
      importStagedHermesArchive({
        workspaceId: "workspace-1",
        name: "History",
        staged,
      }),
    ).rejects.toThrow("workspace is being deleted");
    expect(staged.cleanup).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records completion only after the historical archive volume is copied", async () => {
    mocks.agentRuntimeFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ sandboxId: "sandbox-1" });
    const staged = {
      directory: "/tmp/staged-hermes-home",
      fileCount: 1,
      unpackedBytes: 1,
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      importStagedHermesArchive({
        workspaceId: "workspace-1",
        name: "Recovered assistant",
        importId: "import-request-0001",
        staged,
      }),
    ).resolves.toEqual({ agentId: "agent-1", sandboxId: "sandbox-1" });

    expect(mocks.sandboxUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          config: {
            managedBy: "historical-archive",
            importSource: "hermes-archive",
            readOnly: true,
            hermesArchiveImportRequestId: "import-request-0001",
          },
        },
      }),
    );
    expect(mocks.sandboxUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          config: {
            managedBy: "historical-archive",
            importSource: "hermes-archive",
            readOnly: true,
            hermesArchiveImportRequestId: "import-request-0001",
            hermesArchiveImportCompletedId: "import-request-0001",
          },
        },
      }),
    );
    expect(mocks.sandboxUpdateMany.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.copyHermesArchiveToVolume.mock.invocationCallOrder[0],
    );
  });

  it("reuses a completed historical import without copying or creating another identity", async () => {
    const staged = stagedArchive();
    mocks.agentRuntimeFindFirst.mockResolvedValue({
      agentId: "existing",
      sandboxId: "existing-storage",
    });
    expect(
      await importStagedHermesArchive({
        workspaceId: "workspace-1",
        name: "History",
        importId: "completed",
        staged,
      }),
    ).toEqual({ agentId: "existing", sandboxId: "existing-storage" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.copyHermesArchiveToVolume).not.toHaveBeenCalled();
    expect(staged.cleanup).toHaveBeenCalledOnce();
  });

  it("strictly cleans failed archival storage without retaining an executable Agent", async () => {
    const staged = stagedArchive();
    mocks.copyHermesArchiveToVolume.mockRejectedValue(new Error("Copy failed"));
    await expect(
      importStagedHermesArchive({
        workspaceId: "workspace-1",
        name: "History",
        staged,
      }),
    ).rejects.toThrow("Could not copy the archive");
    expect(mocks.cleanupHermesRuntime).toHaveBeenCalledWith(
      "workspace-1",
      "agent-1",
    );
    expect(mocks.deleteAgent).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(staged.cleanup).toHaveBeenCalledOnce();
  });
});
