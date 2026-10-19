// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  workspace: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  deleteSkills: vi.fn(),
  deleteToolkit: vi.fn(),
  deleteDeployment: vi.fn(),
  deleteClients: vi.fn(),
  decrement: vi.fn(),
  kill: vi.fn(),
  container: vi.fn(),
  volume: vi.fn(),
  operation: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/process/supervisor", () => ({ killProcess: mocks.kill }));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  removeDeploymentContainer: mocks.container,
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  removeDeploymentConfigVolume: mocks.volume,
}));
vi.mock("@/lib/workspace/mcp-operation", () => ({
  runMcpDeploymentOperation: mocks.operation,
}));
import {
  ignoreMarketUpdate,
  removeMarketInstall,
  updateSkillMarketInstall,
} from "@/lib/market/skills";
import {
  buildSkillReleaseManifest,
  skillReleaseChecksum,
} from "@/lib/market/skill-manifest";
const input = { installId: "install", targetWorkspaceId: "w", actorId: "u" };
const install = {
  id: "install",
  listingId: "listing",
  currentReleaseId: "old",
  ignoredReleaseId: null,
  status: "ready",
  resourceMap: {},
  _count: { agentPiPackages: 0 },
  piPackageClientInstallations: [],
  deployment: null,
  toolkit: null,
  installedSkill: { id: "skill", _count: { agentLinks: 0, toolkitLinks: 0 } },
  listing: {
    id: "listing",
    kind: "skill",
    namespace: "team",
    slug: "skill",
    status: "published",
    latestReleaseId: "new",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue({ id: "w" });
  mocks.find.mockResolvedValue(install);
  mocks.update.mockImplementation(async ({ data }) => ({
    ...install,
    ...data,
  }));
  mocks.operation.mockImplementation(async (_workspace, _deployment, run) => ({
    accepted: true,
    value: await run(),
  }));
  mocks.transaction.mockImplementation(async (run) =>
    run({
      $queryRaw: vi.fn(),
      workspace: { findFirst: mocks.workspace },
      marketInstall: {
        findFirst: mocks.find,
        update: mocks.update,
        delete: mocks.remove,
      },
      marketRelease: { findFirst: mocks.release },
      installedSkill: {
        update: mocks.updateSkill,
        delete: mocks.deleteSkill,
        deleteMany: mocks.deleteSkills,
      },
      toolkit: { delete: mocks.deleteToolkit },
      deployment: { delete: mocks.deleteDeployment },
      piPackageClientInstallation: { deleteMany: mocks.deleteClients },
      marketListing: { updateMany: mocks.decrement },
    }),
  );
});

describe("skill market update concurrency", () => {
  it("applies a verified release snapshot and clears ignored/error state", async () => {
    const manifest = buildSkillReleaseManifest({
      skillId: null,
      name: "Updated",
      slug: "updated",
      description: "Description",
      content: "# Updated",
      files: [],
      source: "custom",
      sourceRef: null,
      skill: null,
      userInvocable: true,
      agentInvocable: true,
      effort: "default",
    });
    mocks.release.mockResolvedValue({
      id: "new",
      version: 2,
      manifest,
      checksum: skillReleaseChecksum(manifest),
    });
    const result = await updateSkillMarketInstall({
      ...input,
      currentReleaseId: "old",
      targetReleaseId: "new",
    });
    expect(mocks.updateSkill).toHaveBeenCalledWith({
      where: { id: "skill" },
      data: {
        name: manifest.skill.name,
        slug: manifest.skill.slug,
        description: manifest.skill.description,
        content: manifest.skill.content,
        files: manifest.skill.files,
        sourceRef: "team/skill@2",
      },
    });
    expect(result).toMatchObject({
      currentReleaseId: "new",
      ignoredReleaseId: null,
      status: "ready",
      lastError: null,
    });
  });
  it("treats a completed optimistic update as idempotent but rejects a different revision", async () => {
    mocks.find.mockResolvedValue({ ...install, currentReleaseId: "new" });
    expect(
      await updateSkillMarketInstall({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "new",
      }),
    ).toMatchObject({ currentReleaseId: "new" });
    await expect(
      updateSkillMarketInstall({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "other",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });
  it("requires explicit force for modified content", async () => {
    mocks.find.mockResolvedValue({ ...install, status: "modified" });
    await expect(updateSkillMarketInstall(input)).rejects.toMatchObject({
      code: "local_changes",
    });
    await expect(
      updateSkillMarketInstall({ ...input, force: true }),
    ).rejects.toMatchObject({ code: "release_not_found" });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([
    { ...install, installedSkill: null },
    { ...install, listing: { ...install.listing, kind: "mcp" } },
    null,
  ])("rejects missing or non-skill installs", async (value) => {
    mocks.find.mockResolvedValue(value);
    await expect(updateSkillMarketInstall(input)).rejects.toMatchObject({
      code: "install_not_found",
    });
  });
  it.each([
    { ...install.listing, status: "disabled" },
    { ...install.listing, latestReleaseId: null },
  ])("rejects unavailable listings", async (value) => {
    mocks.find.mockResolvedValue({ ...install, listing: value });
    await expect(updateSkillMarketInstall(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });
  it("rejects a stale selected release and corrupt release snapshot", async () => {
    await expect(
      updateSkillMarketInstall({ ...input, targetReleaseId: "stale" }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    mocks.release.mockResolvedValue({
      id: "new",
      manifest: {},
      checksum: "tampered",
    });
    await expect(updateSkillMarketInstall(input)).rejects.toThrow();
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });
  it("retries serialization conflicts and caps retries", async () => {
    mocks.transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockRejectedValueOnce({ code: "P2034" });
    mocks.find.mockResolvedValue({ ...install, currentReleaseId: "new" });
    expect(
      await updateSkillMarketInstall({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "new",
      }),
    ).toMatchObject({ currentReleaseId: "new" });
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    mocks.transaction.mockRejectedValue({ code: "P2034" });
    await expect(updateSkillMarketInstall(input)).rejects.toMatchObject({
      code: "listing_conflict",
    });
  });
  it("does not retry unknown errors or unauthorized users", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(updateSkillMarketInstall(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.transaction.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(updateSkillMarketInstall(input)).rejects.toThrow(
      "storage unavailable",
    );
  });
  it("ignores only the currently offered release and records the check time", async () => {
    expect(
      await ignoreMarketUpdate({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "new",
      }),
    ).toMatchObject({
      ignoredReleaseId: "new",
      lastCheckedAt: expect.any(Date),
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "install" },
      data: { ignoredReleaseId: "new", lastCheckedAt: expect.any(Date) },
    });
  });
  it("handles repeated ignores idempotently while protecting stale revisions", async () => {
    mocks.find.mockResolvedValue({
      ...install,
      currentReleaseId: "changed",
      ignoredReleaseId: "new",
    });
    expect(
      await ignoreMarketUpdate({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "new",
      }),
    ).toMatchObject({ ignoredReleaseId: "new" });
    await expect(
      ignoreMarketUpdate({
        ...input,
        currentReleaseId: "old",
        targetReleaseId: "other",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    { ...install.listing, status: "disabled" },
    { ...install.listing, latestReleaseId: null },
  ])("does not ignore unavailable releases", async (value) => {
    mocks.find.mockResolvedValue({ ...install, listing: value });
    await expect(ignoreMarketUpdate(input)).rejects.toMatchObject({
      code: "listing_conflict",
    });
  });
  it("rejects missing installations and stale target selections when ignoring", async () => {
    await expect(
      ignoreMarketUpdate({ ...input, targetReleaseId: "stale" }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    mocks.find.mockResolvedValue(null);
    await expect(ignoreMarketUpdate(input)).rejects.toMatchObject({
      code: "install_not_found",
    });
  });
});

describe("market uninstall reference boundaries", () => {
  it.each([
    { _count: { agentPiPackages: 1 } },
    { piPackageClientInstallations: [{ label: "Laptop" }] },
    {
      installedSkill: {
        id: "skill",
        _count: { agentLinks: 1, toolkitLinks: 0 },
      },
    },
    {
      installedSkill: {
        id: "skill",
        _count: { agentLinks: 0, toolkitLinks: 1 },
      },
    },
    {
      deployment: {
        id: "d",
        sandbox: { id: "s" },
        _count: { agentLinks: 0, toolkitLinks: 0, chatAssistantGrants: 0 },
      },
    },
    {
      deployment: {
        id: "d",
        sandbox: null,
        _count: { agentLinks: 1, toolkitLinks: 0, chatAssistantGrants: 0 },
      },
    },
    {
      deployment: {
        id: "d",
        sandbox: null,
        _count: { agentLinks: 0, toolkitLinks: 1, chatAssistantGrants: 0 },
      },
    },
    {
      deployment: {
        id: "d",
        sandbox: null,
        _count: { agentLinks: 0, toolkitLinks: 0, chatAssistantGrants: 1 },
      },
    },
    {
      toolkit: {
        id: "t",
        _count: { agentLinks: 1, apiTokens: 0, installLinks: 0 },
      },
    },
    {
      toolkit: {
        id: "t",
        _count: { agentLinks: 0, apiTokens: 1, installLinks: 0 },
      },
    },
    {
      toolkit: {
        id: "t",
        _count: { agentLinks: 0, apiTokens: 0, installLinks: 1 },
      },
    },
  ])("refuses to destroy referenced resources", async (override) => {
    mocks.find.mockResolvedValue({ ...install, ...override });
    await expect(removeMarketInstall(input)).rejects.toMatchObject({
      code: "in_use",
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("removes an unreferenced skill and its inactive client credentials", async () => {
    expect(await removeMarketInstall(input)).toEqual({ id: "install" });
    expect(mocks.deleteSkill).toHaveBeenCalledWith({ where: { id: "skill" } });
    expect(mocks.deleteClients).toHaveBeenCalledWith({
      where: {
        marketInstallId: "install",
        workspaceId: "w",
        status: { not: "active" },
      },
    });
    expect(mocks.decrement).toHaveBeenCalledWith({
      where: { id: "listing", installCount: { gt: 0 } },
      data: { installCount: { decrement: 1 } },
    });
  });
  it("removes a toolkit and cleans only owned orphaned skill copies", async () => {
    mocks.find.mockResolvedValue({
      ...install,
      listing: { ...install.listing, kind: "toolkit" },
      installedSkill: null,
      toolkit: {
        id: "t",
        _count: { agentLinks: 0, apiTokens: 0, installLinks: 0 },
      },
      resourceMap: {
        ownedInstalledSkillIds: ["owned", 7],
        installedSkillIds: ["borrowed"],
      },
    });
    expect(await removeMarketInstall(input)).toEqual({ id: "install" });
    expect(mocks.deleteToolkit).toHaveBeenCalledWith({ where: { id: "t" } });
    expect(mocks.deleteSkills).toHaveBeenCalledWith({
      where: {
        id: { in: ["owned"] },
        workspaceId: "w",
        agentLinks: { none: {} },
        toolkitLinks: { none: {} },
        marketInstall: { is: null },
      },
    });
  });
  it("stops an MCP before removing its runtime and database resources", async () => {
    mocks.find.mockResolvedValue({
      ...install,
      listing: { ...install.listing, kind: "mcp" },
      installedSkill: null,
      deployment: {
        id: "d",
        source: "npm",
        sandbox: null,
        _count: { agentLinks: 0, toolkitLinks: 0, chatAssistantGrants: 0 },
      },
    });
    expect(await removeMarketInstall(input)).toEqual({ id: "install" });
    expect(mocks.kill).toHaveBeenCalledWith("d", { preventRestart: true });
    expect(mocks.container).toHaveBeenCalledWith("d");
    expect(mocks.volume).toHaveBeenCalledWith("d");
    expect(mocks.deleteDeployment).toHaveBeenCalledWith({ where: { id: "d" } });
    expect(mocks.kill.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteDeployment.mock.invocationCallOrder[0],
    );
  });
  it("does not remove an MCP when the workspace operation is rejected", async () => {
    mocks.find.mockResolvedValue({
      ...install,
      listing: { ...install.listing, kind: "mcp" },
      installedSkill: null,
      deployment: {
        id: "d",
        sandbox: null,
        _count: { agentLinks: 0, toolkitLinks: 0, chatAssistantGrants: 0 },
      },
    });
    mocks.operation.mockResolvedValue({ accepted: false });
    await expect(removeMarketInstall(input)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects missing resources even when an install record remains", async () => {
    mocks.find.mockResolvedValue({ ...install, installedSkill: null });
    await expect(removeMarketInstall(input)).rejects.toMatchObject({
      code: "install_not_found",
    });
    mocks.find.mockResolvedValue(null);
    await expect(removeMarketInstall(input)).rejects.toMatchObject({
      code: "install_not_found",
    });
  });
});
