// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  categories: vi.fn(),
  deployment: vi.fn(),
  toolkit: vi.fn(),
  listing: vi.fn(),
  slug: vi.fn(),
  createListing: vi.fn(),
  updateListing: vi.fn(),
  createRelease: vi.fn(),
  rejectRelease: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  approveMarketRelease: vi.fn(),
  installSkillRelease: vi.fn(),
  updateSkillMarketInstall: vi.fn(),
}));
vi.mock("@/lib/market/pi-package-source", () => ({
  capturePiPackage: vi.fn(),
}));
vi.mock("@/lib/market/pi-package-catalog", () => ({
  resolvePiPackageCaptureSource: vi.fn(),
  verifyOfficialPiPackage: vi.fn(),
}));
vi.mock("@/lib/market/pi-package-assembly", () => ({
  assemblePiPackage: vi.fn(),
  validatePiPackageMcpBindings: vi.fn(),
}));
vi.mock("@/lib/process/supervisor", () => ({ stopProcess: vi.fn() }));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  removeDeploymentContainer: vi.fn(),
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  removeDeploymentConfigVolume: vi.fn(),
}));
vi.mock("@/lib/admin/recipe-validate", () => ({
  validateServerRecipe: vi.fn(),
}));
import {
  parseMcpMarketManifest,
  parseResourceMarketManifest,
  parseToolkitMarketManifest,
  projectPublicResourceMarketManifest,
  publishMcpRelease,
} from "@/lib/market/resources";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { sealMcpEnvironment } from "@/lib/process/mcp-credentials";
const input = {
  workspaceId: "w",
  deploymentId: "d",
  toolkitId: "t",
  publishedById: "u",
  categoryIds: ["c"],
};
const listing = {
  id: "listing",
  publisherWorkspaceId: "w",
  slug: "published-slug",
  latestVersion: 3,
  latestReleaseId: null,
  pendingReleaseId: null,
  status: "draft",
};
const deployment = {
  id: "d",
  workspaceId: "w",
  serverId: null,
  name: "Custom MCP",
  source: "npm",
  sourceRef: "@team/pkg@1.2.3",
  installCfg: sealMcpEnvironment(
    {
      env: { TOKEN: "" },
      requiredEnv: ["OTHER"],
      startCommand: " npm start ",
      network: "none",
    },
    "w",
    { TOKEN: "private-value" },
  ),
  mcpToolExposure: "allowlist",
  mcpAllowedTools: ["untrusted"],
  server: null,
};
const manifest = {
  schemaVersion: 1,
  kind: "mcp",
  listing: {
    slug: "mcp",
    name: "MCP",
    summary: null,
    iconUrl: null,
    tags: [],
    author: "Team",
  },
  mcp: {
    name: "MCP",
    slug: "mcp",
    description: null,
    author: null,
    iconUrl: null,
    readme: null,
    recipe: { source: "npm", ref: "@team/pkg@1.2.3", env: [] },
    toolExposure: "all",
    allowedTools: [],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue({ id: "w", slug: "team", name: "Team" });
  mocks.categories.mockResolvedValue(1);
  mocks.deployment.mockResolvedValue(deployment);
  mocks.toolkit.mockResolvedValue({
    id: "t",
    name: "Toolkit",
    slug: "toolkit",
    servers: [],
    skills: [],
  });
  mocks.listing.mockResolvedValue(null);
  mocks.slug.mockResolvedValue(null);
  mocks.createListing.mockResolvedValue(listing);
  mocks.updateListing.mockResolvedValue(listing);
  mocks.createRelease.mockImplementation(async ({ data }) => ({
    id: "release",
    ...data,
  }));
  mocks.transaction.mockImplementation(async (run) =>
    run({
      workspace: { findFirst: mocks.workspace },
      category: { count: mocks.categories },
      deployment: { findFirst: mocks.deployment },
      toolkit: { findFirst: mocks.toolkit },
      marketListing: {
        findUnique: mocks.listing,
        findFirst: mocks.slug,
        create: mocks.createListing,
        update: mocks.updateListing,
      },
      marketRelease: {
        create: mocks.createRelease,
        updateMany: mocks.rejectRelease,
      },
    }),
  );
});

describe("portable resource publication", () => {
  it("publishes names of required environment variables, never local values or runtime tools", async () => {
    const result = await publishMcpRelease({
      ...input,
      listing: { name: " Listing ", tags: ["Tools", " tools ", ""] },
      releaseNotes: " Notes ",
    });
    expect(result.manifest.mcp.recipe).toEqual({
      source: "npm",
      ref: "@team/pkg@1.2.3",
      env: ["OTHER", "TOKEN"],
      startCommand: "npm start",
      network: "none",
    });
    expect(result.manifest.mcp.allowedTools).toEqual([]);
    expect(result.manifest.mcp).not.toHaveProperty("toolCatalog");
    expect(JSON.stringify(result.manifest)).not.toContain("private-value");
    expect(JSON.stringify(result.manifest)).not.toContain("credentialEnvelope");
    expect(JSON.stringify(result.manifest)).not.toContain("encrypted");
    expect(result.manifest.listing).toMatchObject({
      name: "Listing",
      tags: ["tools"],
    });
    expect(result.release).toMatchObject({
      version: 4,
      reviewStatus: "pending",
      releaseNotes: "Notes",
      categoryIds: ["c"],
      checksum: marketReleaseChecksum(result.manifest),
    });
    expect(mocks.updateListing).toHaveBeenLastCalledWith({
      where: { id: "listing" },
      data: { latestVersion: 4, pendingReleaseId: "release", status: "draft" },
    });
  });
  it("rejects unmigrated plaintext instead of silently publishing it", async () => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      installCfg: { env: { TOKEN: "legacy-private-value" } },
    });
    await expect(publishMcpRelease(input)).rejects.toThrow(
      "MCP_CREDENTIAL_MIGRATION_REQUIRED",
    );
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });

  it("rejects configured credentials embedded in exported metadata", async () => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      name: "MCP private-value",
    });
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });

  it("rejects an envelope bound to another workspace", async () => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      installCfg: sealMcpEnvironment(
        { env: { TOKEN: "" } },
        "another-workspace",
        { TOKEN: "private-value" },
      ),
    });
    await expect(publishMcpRelease(input)).rejects.toThrow(
      "MCP_CREDENTIAL_SCOPE_INVALID",
    );
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });
  it.each([
    { listing: { summary: "Description with private-value" } },
    { releaseNotes: "Release includes private-value" },
  ])(
    "rejects configured credentials anywhere in release content %j",
    async (fields) => {
      await expect(
        publishMcpRelease({ ...input, ...fields }),
      ).rejects.toMatchObject({ code: "invalid_manifest" });
      expect(mocks.createRelease).not.toHaveBeenCalled();
    },
  );
  it("supersedes pending releases without changing published metadata or slug", async () => {
    const existing = {
      ...listing,
      latestReleaseId: "approved",
      pendingReleaseId: "old-pending",
      status: "published",
    };
    mocks.listing.mockResolvedValue(existing);
    mocks.updateListing.mockResolvedValue(existing);
    const result = await publishMcpRelease({
      ...input,
      listing: { slug: "new-slug", name: "New name" },
    });
    expect(result.manifest.listing.slug).toBe("published-slug");
    expect(mocks.slug).not.toHaveBeenCalled();
    expect(mocks.updateListing).toHaveBeenNthCalledWith(1, {
      where: { id: "listing" },
      data: { publishedById: "u", sourceDeploymentId: "d" },
    });
    expect(mocks.rejectRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old-pending", reviewStatus: "pending" },
        data: expect.objectContaining({
          reviewStatus: "rejected",
          reviewNote: "Superseded by a newer publisher submission.",
        }),
      }),
    );
    expect(mocks.updateListing).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "published" }),
      }),
    );
  });
  it("allocates collision-free slugs and updates draft metadata", async () => {
    mocks.listing.mockResolvedValue(listing);
    mocks.slug
      .mockResolvedValueOnce({ id: "conflict" })
      .mockResolvedValueOnce(null);
    const result = await publishMcpRelease({
      ...input,
      listing: { slug: "Team MCP" },
    });
    expect(result.manifest.listing.slug).toBe("team-mcp-2");
    expect(mocks.updateListing).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          slug: "team-mcp-2",
          categories: { set: [{ id: "c" }] },
        }),
      }),
    );
  });
  it.each([
    { categoryIds: [] },
    { categoryIds: ["c", "c"] },
    { categoryIds: [" "] },
  ])("requires unique nonempty categories", async ({ categoryIds }) => {
    await expect(
      publishMcpRelease({ ...input, categoryIds }),
    ).rejects.toMatchObject({ code: "invalid_categories" });
    expect(mocks.deployment).not.toHaveBeenCalled();
  });
  it("rejects nonexistent categories and unauthorized publishers", async () => {
    mocks.categories.mockResolvedValue(0);
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "invalid_categories",
    });
    mocks.workspace.mockResolvedValue(null);
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });
  it.each([publishMcpRelease])(
    "requires a source owned by the publisher",
    async (publish) => {
      mocks.deployment.mockResolvedValue(null);
      mocks.toolkit.mockResolvedValue(null);
      await expect(publish(input)).rejects.toMatchObject({
        code: "source_not_found",
      });
      expect(mocks.createRelease).not.toHaveBeenCalled();
    },
  );
  it.each([publishMcpRelease])(
    "rejects a listing belonging to another workspace",
    async (publish) => {
      mocks.listing.mockResolvedValue({
        ...listing,
        publisherWorkspaceId: "other",
      });
      await expect(publish(input)).rejects.toMatchObject({
        code: "listing_conflict",
      });
      expect(mocks.createRelease).not.toHaveBeenCalled();
    },
  );
  it("does not create duplicate market listings from catalog MCPs", async () => {
    mocks.deployment.mockResolvedValue({ ...deployment, serverId: "catalog" });
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    expect(mocks.createListing).not.toHaveBeenCalled();
  });
  it.each([
    { source: null },
    { source: "sandbox" },
    { sourceRef: null },
    { sourceRef: "invalid package name!" },
  ])("rejects nonportable MCP definitions", async (override) => {
    mocks.deployment.mockResolvedValue({ ...deployment, ...override });
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });
  it("publishes pinned JSON argv with environment names only", async () => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      source: "config",
      sourceRef: "npx",
      installCfg: sealMcpEnvironment(
        {
          command: "npx",
          args: ["-y", "@team/pkg@1.2.3", "two words"],
          env: { TOKEN: "" },
        },
        "w",
        { TOKEN: "private-value" },
      ),
    });
    const result = await publishMcpRelease(input);
    expect(result.manifest.mcp.recipe).toMatchObject({
      source: "config",
      ref: "npx",
      command: "npx",
      args: ["-y", "@team/pkg@1.2.3", "two words"],
      env: ["TOKEN"],
    });
    expect(JSON.stringify(result.manifest)).not.toContain("private-value");
  });
  it.each([
    ["--token", "credential"],
    ["--label", "private-value"],
  ])("rejects credential-bearing JSON argv %j", async (flag, value) => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      source: "config",
      sourceRef: "npx",
      installCfg: sealMcpEnvironment(
        {
          command: "npx",
          args: ["-y", "@team/pkg@1.2.3", flag, value],
          env: { TOKEN: "" },
        },
        "w",
        { TOKEN: "private-value" },
      ),
    });
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });
  it("publishes the edited deployment version rather than its previously approved catalog recipe", async () => {
    mocks.listing.mockResolvedValue(listing);
    mocks.deployment.mockResolvedValue({
      ...deployment,
      sourceRef: "@team/pkg@2.0.0",
      serverId: "catalog",
      server: {
        name: "MCP",
        slug: "mcp",
        installCfg: { source: "npm", ref: "@team/pkg@1.0.0", env: [] },
      },
    });
    const result = await publishMcpRelease(input);
    expect(result.manifest.mcp.recipe.ref).toBe("@team/pkg@2.0.0");
  });
  it("reconstructs remote authentication requirements without secret values", async () => {
    mocks.deployment.mockResolvedValue({
      ...deployment,
      source: "remote",
      sourceRef: "https://mcp.example.com/",
      installCfg: sealMcpEnvironment(
        {
          env: { TOKEN: "" },
          transport: "sse",
          authType: "bearer",
          bearerEnv: "TOKEN",
        },
        "w",
        { TOKEN: "private-value" },
      ),
    });
    const result = await publishMcpRelease(input);
    expect(result.manifest.mcp.recipe).toEqual({
      source: "remote",
      ref: "https://mcp.example.com/",
      env: ["TOKEN"],
      transport: "sse",
      authType: "bearer",
      bearerEnv: "TOKEN",
    });
  });
  it("blocks credential-like release notes before any listing is persisted", async () => {
    await expect(
      publishMcpRelease({
        ...input,
        releaseNotes: `token: sk-proj-${"x".repeat(30)}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(mocks.createListing).not.toHaveBeenCalled();
  });
  it.each(["P2002", "P2034"])(
    "maps concurrent %s publication failures to a conflict",
    async (code) => {
      for (const publish of [publishMcpRelease]) {
        mocks.transaction.mockRejectedValueOnce({ code });
        await expect(publish(input)).rejects.toMatchObject({
          code: "listing_conflict",
        });
      }
    },
  );
  it("preserves unknown infrastructure failures", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(publishMcpRelease(input)).rejects.toThrow(
      "database unavailable",
    );
  });
});

describe("resource manifest trust boundary", () => {
  it("validates checksum and projects public MCPs without their tool surface", () => {
    const parsed = parseMcpMarketManifest({
      ...manifest,
      mcp: {
        ...manifest.mcp,
        allowedTools: ["search"],
        toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
      },
    });
    expect(
      parseResourceMarketManifest(parsed, marketReleaseChecksum(parsed)),
    ).toEqual(parsed);
    const projected = projectPublicResourceMarketManifest(parsed);
    expect(projected).toMatchObject({ kind: "mcp", mcp: { allowedTools: [] } });
    expect(
      projected && "mcp" in projected ? projected.mcp : {},
    ).not.toHaveProperty("toolCatalog");
    expect(parsed.mcp.allowedTools).toEqual(["search"]);
    expect(() => parseMcpMarketManifest(parsed, "tampered")).toThrow(
      "checksum",
    );
  });
  it.each([null, [], {}, { kind: "assistant" }, { kind: "pi-package" }])(
    "rejects unsupported or malformed resource manifests",
    (raw) => {
      expect(() => parseResourceMarketManifest(raw)).toThrow();
    },
  );
  it("rejects cyclic, oversized and unknown-field snapshots", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseMcpMarketManifest(cyclic)).toThrow("invalid");
    expect(() =>
      parseMcpMarketManifest({ ...manifest, padding: "x".repeat(4000001) }),
    ).toThrow("too large");
    expect(() =>
      parseMcpMarketManifest({ ...manifest, unexpected: true }),
    ).toThrow("invalid");
  });
  it("projects each toolkit connector independently without mutating private snapshots", () => {
    const mcp = parseMcpMarketManifest(manifest).mcp;
    const toolkit = parseToolkitMarketManifest({
      schemaVersion: 1,
      kind: "toolkit",
      listing: manifest.listing,
      toolkit: { name: "Toolkit", slug: "toolkit" },
      mcps: [{ ...mcp, catalogSlug: "catalog", allowedTools: ["private"] }],
      skills: [],
    });
    expect(projectPublicResourceMarketManifest(toolkit)).toMatchObject({
      kind: "toolkit",
      mcps: [{ allowedTools: [] }],
    });
    expect(toolkit.mcps[0].allowedTools).toEqual(["private"]);
  });
});

describe("verified catalog composition", () => {
  it("rejects creating a duplicate listing for an existing catalog MCP", async () => {
    mocks.deployment.mockResolvedValue({ ...deployment, serverId: "catalog" });
    await expect(publishMcpRelease(input)).rejects.toMatchObject({
      code: "listing_conflict",
      message: "Catalog MCPs are already represented in the market.",
    });
    expect(mocks.createListing).not.toHaveBeenCalled();
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });
  it("uses catalog recipes for existing catalog-backed listings without a deployment recipe and exports only validated tools", async () => {
    mocks.listing.mockResolvedValue(listing);
    const toolCatalog = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];
    const server = {
      slug: "catalog",
      name: "Catalog MCP",
      author: "Catalog Author",
      description: "Catalog description",
      iconUrl: "https://example.com/icon.png",
      readme: "# Catalog",
      verifiedAt: new Date(0),
      verifiedTools: 1,
      installCfg: {
        source: "remote",
        ref: "https://mcp.example.com/",
        sourceUrl: "https://github.com/team/mcp",
        env: ["TOKEN"],
        envValues: { ENDPOINT: "https://api.example.com/" },
        transport: "streamable-http",
        authType: "headers",
        headerEnv: { "X-Api-Key": "TOKEN" },
        toolCatalog,
      },
    };
    mocks.deployment.mockResolvedValue({
      ...deployment,
      source: null,
      sourceRef: null,
      serverId: "catalog",
      server,
      mcpAllowedTools: ["search", "unverified", "search"],
    });
    const result = await publishMcpRelease(input);
    expect(result.manifest.mcp).toMatchObject({
      catalogSlug: "catalog",
      name: "Catalog MCP",
      author: "Catalog Author",
      readme: "# Catalog",
      allowedTools: ["search"],
      toolCatalog,
      recipe: {
        source: "remote",
        ref: "https://mcp.example.com/",
        sourceUrl: "https://github.com/team/mcp",
        env: ["ENDPOINT", "TOKEN"],
        authType: "headers",
        headerEnv: { "X-Api-Key": "TOKEN" },
      },
    });
    expect(result.manifest.mcp.recipe).not.toHaveProperty("envValues");
  });
});
