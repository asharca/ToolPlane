// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  workspace: vi.fn(),
  release: vi.fn(),
  find: vi.fn(),
  unique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  server: vi.fn(),
  deploymentFind: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpdate: vi.fn(),
  listingUpdate: vi.fn(),
  stop: vi.fn(),
  container: vi.fn(),
  volume: vi.fn(),
  operation: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { $transaction: m.transaction, marketInstall: { findFirst: m.find } },
}));
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
vi.mock("@/lib/process/supervisor", () => ({ stopProcess: m.stop }));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  removeDeploymentContainer: m.container,
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  removeDeploymentConfigVolume: m.volume,
}));
vi.mock("@/lib/workspace/mcp-operation", () => ({
  runMcpDeploymentOperation: m.operation,
}));
import { installMcpRelease, updateMarketInstall } from "@/lib/market/resources";
import { marketReleaseChecksum } from "@/lib/market/artifact";
const manifest = {
  schemaVersion: 1,
  kind: "mcp",
  listing: {
    slug: "connector",
    name: "Connector",
    summary: null,
    iconUrl: null,
    tags: [],
    author: "Team",
  },
  mcp: {
    name: "Connector",
    slug: "connector",
    catalogSlug: "connector",
    description: null,
    author: null,
    iconUrl: null,
    readme: null,
    recipe: {
      source: "remote",
      ref: "https://mcp.example.com/",
      env: [] as string[],
      transport: "streamable-http",
      authType: "none",
    },
    toolExposure: "allowlist",
    allowedTools: ["search", "untrusted"],
  },
};
const listing = {
  id: "l",
  kind: "mcp",
  namespace: "team",
  slug: "connector",
  status: "published",
  latestReleaseId: "r",
  visibility: "public",
  publisherWorkspaceId: "publisher",
  sourceServerId: "s",
  categories: [],
};
const release = {
  id: "r",
  listingId: "l",
  version: 2,
  reviewStatus: "approved",
  listing,
  manifest,
  checksum: marketReleaseChecksum(manifest),
};
const install = {
  id: "i",
  status: "ready",
  currentReleaseId: "old",
  deploymentId: "d",
  deployment: {
    id: "d",
    status: "stopped",
    installCfg: { env: { TOKEN: "secret", OLD: "keep" } },
  },
  listing,
};
const server = {
  id: "s",
  verifiedAt: new Date(),
  verifiedTools: 1,
  installCfg: {
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
  },
};
const input = {
  releaseId: "r",
  targetWorkspaceId: "w",
  installedById: "u",
  idempotencyKey: "key",
};
const update = { installId: "i", targetWorkspaceId: "w", actorId: "u" };
beforeEach(() => {
  vi.resetAllMocks();
  m.workspace.mockResolvedValue({ id: "w" });
  m.release.mockResolvedValue(release);
  m.find.mockResolvedValue(install);
  m.unique.mockResolvedValue(null);
  m.server.mockResolvedValue(server);
  m.deploymentFind.mockResolvedValue(null);
  m.deploymentCreate.mockImplementation(async ({ data }) => ({
    id: "d",
    ...data,
  }));
  m.create.mockImplementation(async ({ data }) => ({ id: "i", ...data }));
  m.update.mockImplementation(async ({ data }) => ({ ...install, ...data }));
  m.operation.mockImplementation(async (_workspace, _deployment, run) => ({
    accepted: true,
    value: await run(),
  }));
  m.transaction.mockImplementation(async (run) =>
    run({
      workspace: { findFirst: m.workspace },
      marketRelease: { findUnique: m.release, findFirst: m.release },
      marketInstall: {
        findUnique: m.unique,
        findFirst: m.find,
        create: m.create,
        update: m.update,
      },
      server: { findFirst: m.server },
      deployment: {
        findUnique: m.deploymentFind,
        create: m.deploymentCreate,
        update: m.deploymentUpdate,
      },
      marketListing: { update: m.listingUpdate },
    }),
  );
});
describe("connector installation trust boundaries", () => {
  it.each(["", " ", "x".repeat(201)])(
    "rejects invalid idempotency keys before a transaction",
    async (idempotencyKey) => {
      await expect(
        installMcpRelease({ ...input, idempotencyKey }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );
  it("requires workspace access", async () => {
    m.workspace.mockResolvedValue(null);
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(m.release).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...release, listing: { ...listing, kind: "skill" } },
    { ...release, listing: { ...listing, status: "disabled" } },
    { ...release, reviewStatus: "pending" },
    { ...release, listing: { ...listing, latestReleaseId: "other" } },
    { ...release, listing: { ...listing, visibility: "private" } },
  ])(
    "rejects unavailable, stale and cross-workspace private releases",
    async (value) => {
      m.release.mockResolvedValue(value);
      await expect(installMcpRelease(input)).rejects.toMatchObject({
        code: "listing_unavailable",
      });
      expect(m.deploymentCreate).not.toHaveBeenCalled();
    },
  );
  it("permits private publisher-workspace installation", async () => {
    m.release.mockResolvedValue({
      ...release,
      listing: { ...listing, visibility: "private", publisherWorkspaceId: "w" },
    });
    expect(await installMcpRelease(input)).toMatchObject({ reused: false });
  });
  it("rejects checksummed informational server recipes", async () => {
    const local = {
      ...manifest,
      mcp: { ...manifest.mcp, recipe: { source: "npm", ref: "pkg", env: [] } },
    };
    m.release.mockResolvedValue({
      ...release,
      manifest: local,
      checksum: marketReleaseChecksum(local),
    });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });
  it("reuses an identical attached installation without duplicating counts", async () => {
    m.unique.mockResolvedValueOnce({
      id: "existing",
      requestedReleaseId: "r",
      deployment: { id: "d", installCfg: {} },
    });
    expect(await installMcpRelease(input)).toMatchObject({
      reused: true,
      install: { id: "existing" },
      resource: { id: "d" },
    });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.listingUpdate).not.toHaveBeenCalled();
  });
  it.each([
    { requestedReleaseId: "other", deployment: { installCfg: {} } },
    { requestedReleaseId: "r", deployment: null },
    { requestedReleaseId: "r", deployment: { id: "wrong-type" } },
  ])(
    "rejects reused keys with a different target or detached resource",
    async (existing) => {
      m.unique.mockResolvedValueOnce(existing);
      await expect(installMcpRelease(input)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    },
  );
  it("refuses already-installed listings and preexisting catalog deployments", async () => {
    m.unique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "existing" });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "already_installed",
    });
    m.deploymentFind.mockResolvedValue({ id: "existing-deployment" });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "already_installed",
    });
  });
  it("requires a catalog identity and still-verified tool snapshot", async () => {
    m.release.mockResolvedValueOnce({
      ...release,
      listing: { ...listing, sourceServerId: null },
    });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    m.server
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...server, verifiedTools: 5 });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    await expect(installMcpRelease(input)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });
  it.each([{ env: [] as string[] }, { env: ["TOKEN"] }])(
    "installs only trusted tools and records required setup",
    async ({ env }) => {
      const snapshot = {
        ...manifest,
        mcp: { ...manifest.mcp, recipe: { ...manifest.mcp.recipe, env } },
      };
      m.release.mockResolvedValue({
        ...release,
        manifest: snapshot,
        checksum: marketReleaseChecksum(snapshot),
      });
      const result = await installMcpRelease({
        ...input,
        idempotencyKey: " key ",
      });
      expect(result).toMatchObject({
        reused: false,
        install: {
          idempotencyKey: "key",
          status: env.length ? "setup_required" : "ready",
          requirements: { environment: env },
        },
        resource: {
          mcpAllowedTools: ["search"],
          status: env.length ? "setup_required" : "stopped",
        },
      });
      expect(m.listingUpdate).toHaveBeenCalledWith({
        where: { id: "l" },
        data: { installCount: { increment: 1 } },
      });
    },
  );
  it("retries serialization and uniqueness races but preserves terminal failures", async () => {
    m.transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockRejectedValueOnce({ code: "P2002" });
    expect(await installMcpRelease(input)).toMatchObject({ reused: false });
    expect(m.transaction).toHaveBeenCalledTimes(3);
    m.transaction.mockRejectedValue(new Error("offline"));
    await expect(installMcpRelease(input)).rejects.toThrow("offline");
  });
});
describe("connector update coordination", () => {
  it("does not update unknown install kinds", async () => {
    m.find.mockResolvedValue(null);
    await expect(updateMarketInstall(update)).rejects.toMatchObject({
      code: "install_not_found",
    });
  });
  it.each([
    { ...install, deploymentId: null },
    { ...install, status: "modified" },
    { ...install, currentReleaseId: "changed" },
    { ...install, listing: { ...listing, status: "disabled" } },
    { ...install, listing: { ...listing, latestReleaseId: null } },
  ])(
    "protects local changes and stale state before stopping runtime",
    async (value) => {
      m.find.mockResolvedValue(value);
      await expect(
        updateMarketInstall({
          ...update,
          currentReleaseId: "old",
          targetReleaseId: "r",
        }),
      ).rejects.toThrow();
      expect(m.stop).not.toHaveBeenCalled();
    },
  );
  it("rejects an unavailable requested release", async () => {
    m.release.mockResolvedValue(null);
    await expect(updateMarketInstall(update)).rejects.toMatchObject({
      code: "release_not_found",
    });
    expect(m.operation).not.toHaveBeenCalled();
  });
  it("rejects workspace teardown without stopping the connector", async () => {
    m.operation.mockResolvedValue({ accepted: false });
    await expect(updateMarketInstall(update)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    expect(m.stop).not.toHaveBeenCalled();
  });
  it.each([
    { env: ["TOKEN"], state: "setup_required", expected: "ready" },
    { env: ["NEW"], state: "stopped", expected: "setup_required" },
    { env: [] as string[], state: "running", expected: "ready" },
  ])(
    "preserves environment values and computes setup state",
    async ({ env, state, expected }) => {
      const snapshot = {
        ...manifest,
        mcp: { ...manifest.mcp, recipe: { ...manifest.mcp.recipe, env } },
      };
      m.release.mockResolvedValue({
        ...release,
        manifest: snapshot,
        checksum: marketReleaseChecksum(snapshot),
      });
      m.find.mockResolvedValue({
        ...install,
        deployment: { ...install.deployment, status: state },
      });
      const result = await updateMarketInstall(update);
      expect(result).toMatchObject({
        currentReleaseId: "r",
        requestedReleaseId: "r",
        ignoredReleaseId: null,
        lastError: null,
        status: expected,
      });
      expect(m.deploymentUpdate.mock.calls[0][0].data).toMatchObject({
        mcpAllowedTools: ["search"],
        installCfg: {
          env: expect.objectContaining(
            env.includes("TOKEN")
              ? { TOKEN: "secret" }
              : env.includes("NEW")
                ? { NEW: "" }
                : {},
          ),
        },
      });
      expect(m.stop).toHaveBeenCalledWith("d");
      expect(m.container).toHaveBeenCalledWith("d");
      expect(m.volume).toHaveBeenCalledWith("d");
    },
  );
  it("revalidates availability after stopping runtime", async () => {
    m.find
      .mockResolvedValueOnce(install)
      .mockResolvedValueOnce(install)
      .mockResolvedValueOnce({ ...install, deployment: null });
    await expect(updateMarketInstall(update)).rejects.toMatchObject({
      code: "install_not_found",
    });
    expect(m.stop).toHaveBeenCalled();
    expect(m.deploymentUpdate).not.toHaveBeenCalled();
  });
  it("does not overwrite concurrent updates after acquiring the operation", async () => {
    m.find
      .mockResolvedValueOnce(install)
      .mockResolvedValueOnce(install)
      .mockResolvedValueOnce({ ...install, currentReleaseId: "other" });
    await expect(
      updateMarketInstall({
        ...update,
        currentReleaseId: "old",
        targetReleaseId: "r",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    expect(m.deploymentUpdate).not.toHaveBeenCalled();
  });
  it("requires a verified catalog again inside the update transaction", async () => {
    m.server.mockResolvedValue(null);
    await expect(updateMarketInstall(update)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    expect(m.deploymentUpdate).not.toHaveBeenCalled();
  });
});
