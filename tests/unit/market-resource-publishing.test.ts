// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const moderation = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ marketListing: moderation }),
  },
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: vi.fn() }));
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
vi.mock("@/lib/market/pi-package-assembly", () => ({
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
} from "@/lib/market/resources";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { updateAdminMarketListing } from "@/lib/admin/market-catalog";
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

describe("catalog moderation publication boundary", () => {
  it.each(["draft", "disabled"])(
    "cannot publish a %s immutable listing through moderation",
    async (status) => {
      moderation.findUnique.mockResolvedValue({
        id: "listing",
        kind: "pi-package",
        status,
        latestRelease: { reviewStatus: "approved" },
      });
      await expect(
        updateAdminMarketListing({
          id: "listing",
          status: "published",
          curated: true,
          isFeatured: false,
          categoryIds: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_status" });
      expect(moderation.update).not.toHaveBeenCalled();
    },
  );
});
