// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiPackageMcpBindings } from "@/lib/market/pi-package-assembly";
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  workspace: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  validate: vi.fn(),
  sandboxes: vi.fn(),
  task: vi.fn(),
  work: vi.fn(),
  busy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  approveMarketRelease: vi.fn(),
  installSkillRelease: vi.fn(),
  updateSkillMarketInstall: vi.fn(),
}));
vi.mock("@/lib/market/pi-package-assembly", () => ({
  assemblePiPackage: vi.fn(),
  validatePiPackageMcpBindings: m.validate,
}));
vi.mock("@/lib/agents/sandbox-execution-gate", () => ({
  sandboxExecutionBusy: m.busy,
}));
import { updatePiPackageMcpBindings } from "@/lib/market/resources";
import { marketReleaseChecksum } from "@/lib/market/artifact";
const body = "export default function() {}";
const manifest = {
  schemaVersion: 1,
  kind: "pi-package",
  listing: {
    slug: "pkg",
    name: "Package",
    summary: null,
    iconUrl: null,
    tags: [],
    author: "Team",
  },
  package: {
    source: {
      kind: "npm",
      requested: "npm:pkg@1.0.0",
      name: "pkg",
      version: "1.0.0",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    },
    name: "pkg",
    version: "1.0.0",
    root: "package",
    runtime: {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 24,
      platform: "linux",
      arch: "arm64",
    },
    resources: {
      extensions: ["package/index.js"],
      skills: [],
      prompts: [],
      themes: [],
    },
    entries: [
      { type: "directory", path: "package" },
      {
        type: "file",
        path: "package/index.js",
        contentEncoding: "base64",
        content: Buffer.from(body).toString("base64"),
        executable: false,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ],
    toolplane: {
      schemaVersion: 1,
      mcp: [{ key: "search", name: "Search", tools: ["search"] }],
    },
  },
};
const release = {
  id: "r",
  listingId: "l",
  reviewStatus: "approved",
  manifest,
  checksum: marketReleaseChecksum(manifest),
  releaseNotes: null,
};
const install = {
  id: "i",
  listingId: "l",
  listing: {
    kind: "pi-package",
    status: "published",
    visibility: "public",
    publisherWorkspaceId: "publisher",
  },
  currentRelease: release,
  agentPiPackages: [],
};
const input = {
  workspaceId: "w",
  userId: "u",
  marketInstallId: "i",
  mcpBindings: { search: { deploymentId: "deployment", tools: ["search"] } },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.workspace.mockResolvedValue({ id: "w" });
  m.find.mockResolvedValue(install);
  m.sandboxes.mockResolvedValue([]);
  m.task.mockResolvedValue(null);
  m.work.mockResolvedValue(null);
  m.busy.mockReturnValue(false);
  m.update.mockImplementation(async ({ data }) => ({ id: "i", ...data }));
  m.transaction.mockImplementation(async (run) =>
    run({
      $queryRaw: vi.fn(),
      workspace: { findFirst: m.workspace },
      marketInstall: { findFirst: m.find, update: m.update },
      agentSandbox: { findMany: m.sandboxes },
      a2ATask: { findFirst: m.task },
      workSession: { findFirst: m.work },
    }),
  );
});
describe("package MCP binding safety", () => {
  it.each([{ value: null }, { value: "invalid" }, { value: [] }])(
    "rejects non-object bindings before writes",
    async ({ value }) => {
      await expect(
        updatePiPackageMcpBindings({
          ...input,
          mcpBindings: value as unknown as PiPackageMcpBindings,
        }),
      ).rejects.toMatchObject({ code: "pi_package_invalid_bindings" });
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );
  it("requires installer access", async () => {
    m.workspace.mockResolvedValue(null);
    await expect(updatePiPackageMcpBindings(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
  });
  it.each([
    null,
    { ...install, listing: { ...install.listing, kind: "mcp" } },
    { ...install, listing: { ...install.listing, status: "disabled" } },
    { ...install, listing: { ...install.listing, visibility: "private" } },
  ])(
    "refuses unavailable and foreign private package installs",
    async (value) => {
      m.find.mockResolvedValue(value);
      await expect(updatePiPackageMcpBindings(input)).rejects.toMatchObject({
        code: "install_not_found",
      });
      expect(m.update).not.toHaveBeenCalled();
    },
  );
  it("allows private packages in their publisher workspace and persists only binding resource state", async () => {
    m.find.mockResolvedValue({
      ...install,
      listing: {
        ...install.listing,
        visibility: "private",
        publisherWorkspaceId: "w",
      },
    });
    expect(await updatePiPackageMcpBindings(input)).toEqual({
      id: "i",
      resourceMap: { kind: "pi-package", mcpBindings: input.mcpBindings },
    });
    expect(m.validate).toHaveBeenCalledOnce();
  });
  it.each([
    { ...release, listingId: "other" },
    { ...release, reviewStatus: "pending" },
  ])("rejects unavailable pinned releases", async (currentRelease) => {
    m.find.mockResolvedValue({ ...install, currentRelease });
    await expect(updatePiPackageMcpBindings(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });
  it("requires every declared MCP key and preserves previous bindings when validation fails", async () => {
    await expect(
      updatePiPackageMcpBindings({ ...input, mcpBindings: {} }),
    ).rejects.toMatchObject({ code: "pi_package_invalid_bindings" });
    m.validate.mockRejectedValueOnce(new Error("tool unavailable"));
    await expect(updatePiPackageMcpBindings(input)).rejects.toThrow(
      "tool unavailable",
    );
    expect(m.update).not.toHaveBeenCalled();
  });
  it("validates each distinct pinned release once", async () => {
    m.find.mockResolvedValue({
      ...install,
      agentPiPackages: [
        { agentId: "a", agent: { workspaceId: "w" }, release },
        { agentId: "b", agent: { workspaceId: "w" }, release },
      ],
    });
    await updatePiPackageMcpBindings(input);
    expect(m.validate).toHaveBeenCalledOnce();
    expect(m.sandboxes).toHaveBeenCalledWith({
      where: { agentId: { in: ["a", "b"] } },
      select: { sandboxId: true },
    });
  });
  it("refuses cross-workspace agent bindings", async () => {
    m.find.mockResolvedValue({
      ...install,
      agentPiPackages: [
        { agentId: "a", agent: { workspaceId: "other" }, release },
      ],
    });
    await expect(updatePiPackageMcpBindings(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(m.update).not.toHaveBeenCalled();
  });
  it.each(["task", "work", "sandbox"])(
    "refuses rebinding while agent has active %s execution",
    async (kind) => {
      m.find.mockResolvedValue({
        ...install,
        agentPiPackages: [
          { agentId: "a", agent: { workspaceId: "w" }, release },
        ],
      });
      if (kind === "task") m.task.mockResolvedValue({ id: "task" });
      if (kind === "work") m.work.mockResolvedValue({ id: "work" });
      if (kind === "sandbox") {
        m.sandboxes.mockResolvedValue([{ sandboxId: "sandbox" }]);
        m.busy.mockReturnValue(true);
      }
      await expect(updatePiPackageMcpBindings(input)).rejects.toMatchObject({
        code: "pi_package_agent_busy",
      });
      expect(m.update).not.toHaveBeenCalled();
    },
  );
});
