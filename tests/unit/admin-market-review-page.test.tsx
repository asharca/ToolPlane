import { Buffer } from "node:buffer";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  admin: vi.fn(),
  release: vi.fn(),
  skill: vi.fn(),
  assistant: vi.fn(),
  mcp: vi.fn(),
  toolkit: vi.fn(),
  pi: vi.fn(),
  scan: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(",")}` : key,
      { has: () => true },
    ),
}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: m.admin }));
vi.mock("@/lib/db", () => ({
  db: { marketRelease: { findFirst: m.release } },
}));
vi.mock("@/lib/admin/categories", () => ({
  listCategories: async () => [{ id: "cat", name: "Research" }],
}));
vi.mock("@/lib/admin/market-review-actions", () => ({
  approveMarketReleaseAction: vi.fn(),
  rejectMarketReleaseAction: vi.fn(),
}));
vi.mock("@/lib/market/skill-manifest", () => ({
  parseSkillReleaseManifest: m.skill,
}));
vi.mock("@/lib/market/assistant-manifest", () => ({
  parseAssistantReleaseManifest: m.assistant,
}));
vi.mock("@/lib/market/resources", () => ({
  parseMcpMarketManifest: m.mcp,
  parseToolkitMarketManifest: m.toolkit,
}));
vi.mock("@/lib/market/pi-package-manifest", () => ({
  parsePiPackageReleaseManifest: m.pi,
  scanPiPackageReleaseManifest: m.scan,
}));
vi.mock("@/components/admin/ReleaseChanges", () => ({
  ReleaseChanges: () => null,
}));
import Review from "@/app/admin/reviews/market/[id]/page";
const props = (
  query: { releaseId?: string; path?: string; returnTo?: string } = {
    releaseId: "release",
  },
) => ({
  params: Promise.resolve({ id: "listing" }),
  searchParams: Promise.resolve(query),
});
const release = (kind = "skill", patch = {}, listingPatch = {}) => ({
  id: "release",
  version: 2,
  name: "Research",
  reviewStatus: "pending",
  createdAt: new Date("2026-08-01"),
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: null,
  releaseNotes: "",
  manifest: {},
  checksum: "sha256-test",
  releaseSummary: { files: 2 },
  scanResult: null,
  categoryIds: [],
  listing: {
    id: "listing",
    name: "Research release",
    namespace: "acme",
    slug: "research",
    kind,
    publisherWorkspace: { name: "Acme publishing" },
    publishedBy: null,
    publisherKind: "workspace",
    pendingReleaseId: "release",
    categories: [{ id: "cat" }],
    releases: [],
    ...listingPatch,
  },
  ...patch,
});
const packageManifest = (
  entries: unknown[] = [],
  source: Record<string, string> = {
    kind: "npm",
    requested: "npm:@acme/research",
    name: "@acme/research",
    version: "1.0.0",
    integrity: "sha512-integrity",
  },
) => ({
  package: {
    name: "@acme/research",
    version: "1.0.0",
    source,
    runtime: {
      kind: "pi",
      piVersion: "0.1",
      nodeMajor: 26,
      platform: "linux",
      arch: "x64",
    },
    resources: { extensions: entries.length ? ["extension.ts"] : [] },
    entries,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue({ id: "admin" });
  m.release.mockResolvedValue(release());
  for (const parser of [m.skill, m.assistant, m.mcp, m.toolkit, m.pi])
    parser.mockImplementation(() => {
      throw new Error("Invalid checksum");
    });
  m.scan.mockReturnValue({ status: "passed", findings: [] });
});
afterEach(cleanup);
describe("administrator release review security and rendering", () => {
  it("requires administrator authentication before loading release data", async () => {
    m.admin.mockRejectedValue(new Error("Admin required"));
    await expect(Review(props())).rejects.toThrow("Admin required");
    expect(m.release).not.toHaveBeenCalled();
  });
  it("returns notFound for a release outside the selected listing", async () => {
    m.release.mockResolvedValue(null);
    await expect(Review(props())).rejects.toThrow("notFound");
  });
  it("canonicalizes pending release links to a stable release ID", async () => {
    await expect(Review(props({}))).rejects.toThrow(
      "redirect:/admin/reviews/market/listing?releaseId=release&returnTo=%2Fadmin%2Freviews",
    );
  });
  it.each(["skill", "assistant", "mcp", "toolkit", "pi-package"])(
    "warns about invalid %s artifacts instead of showing unverified contents",
    async (kind) => {
      m.release.mockResolvedValue(release(kind));
      render(await Review(props()));
      expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
        "errorInvalidMarketRelease",
      );
      expect(screen.queryByText("Invalid checksum")).not.toBeInTheDocument();
    },
  );
  it.each([
    ["workspace", { name: "Acme publishing" }, null, "Acme publishing"],
    ["user", null, { name: "Ada", email: "ada@example.com" }, "Ada"],
    ["user", null, { name: null, email: "ada@example.com" }, "ada@example.com"],
    ["administrator", null, null, "administrator"],
  ])(
    "resolves the %s publisher identity",
    async (publisherKind, publisherWorkspace, publishedBy, expected) => {
      m.release.mockResolvedValue(
        release(
          "skill",
          {},
          { publisherKind, publisherWorkspace, publishedBy },
        ),
      );
      render(await Review(props()));
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );
  it.each([
    ["pending", "release", true],
    ["approved", "release", false],
    ["rejected", "release", false],
    ["pending", "newer-release", false],
  ])(
    "only presents decisions for current pending releases (%s/%s)",
    async (reviewStatus, pendingReleaseId, actionable) => {
      m.skill.mockReturnValue({
        skill: { content: "# Verified skill instructions", files: [] },
      });
      m.release.mockResolvedValue(
        release(
          "skill",
          {
            reviewStatus,
            reviewedBy: { name: null, email: "reviewer@example.com" },
            reviewedAt: new Date("2026-08-02"),
            reviewNote: "Review decision",
          },
          { pendingReleaseId },
        ),
      );
      render(await Review(props()));
      expect(
        screen.queryByRole("button", { name: "Approve release" }) !== null,
      ).toBe(actionable);
      if (!actionable)
        expect(screen.getByText(/reviewer@example.com/)).toBeInTheDocument();
    },
  );
  it("renders verified skill content and explicitly reports absent bundled files", async () => {
    m.skill.mockReturnValue({
      skill: { content: "# Verified skill instructions", files: [] },
    });
    render(await Review(props()));
    expect(
      screen.getByText("# Verified skill instructions"),
    ).toBeInTheDocument();
    expect(screen.getByText("marketReleaseNoBundledFiles")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Research" })).toBeChecked();
  });
  it.each([false, true])(
    "renders assistant instructions and optional dependencies (populated=%s)",
    async (populated) => {
      m.release.mockResolvedValue(release("assistant"));
      m.assistant.mockReturnValue({
        assistant: {
          systemPrompt: populated ? "Do focused research" : "",
          modelRequirement: populated
            ? { model: "gpt-research", providerFormat: "openai" }
            : null,
          maxSteps: 12,
          mcpRequirements: populated
            ? [{ name: "Search server", catalogSlug: "search" }]
            : [],
        },
      });
      render(await Review(props()));
      expect(
        screen.getByText(
          populated
            ? "Do focused research"
            : "marketAssistantInstructionsEmpty",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          populated ? "Search server" : "marketAssistantNoMcpRequirements",
        ),
      ).toBeInTheDocument();
    },
  );
  it.each([false, true])(
    "renders MCP environment and exposed tool requirements (populated=%s)",
    async (populated) => {
      m.release.mockResolvedValue(release("mcp"));
      m.mcp.mockReturnValue({
        mcp: {
          recipe: {
            source: "npm",
            ref: "@acme/search",
            env: populated ? ["SEARCH_API_KEY"] : [],
          },
          toolExposure: populated ? "allowlist" : "all",
          allowedTools: populated ? ["search_documents"] : [],
        },
      });
      render(await Review(props()));
      expect(screen.getByText("npm:@acme/search")).toBeInTheDocument();
      if (populated) {
        expect(screen.getByText("SEARCH_API_KEY")).toBeInTheDocument();
        expect(screen.getByText("search_documents")).toBeInTheDocument();
      }
    },
  );
  it("preserves repeated toolkit skill identities and distinguishes catalog and snapshot requirements", async () => {
    m.release.mockResolvedValue(release("toolkit"));
    m.toolkit.mockReturnValue({
      mcps: [
        {
          name: "Search server",
          catalogSlug: "search",
          recipe: { env: ["SEARCH_TOKEN"] },
        },
        { name: "Local server", catalogSlug: "local", recipe: { env: [] } },
      ],
      skills: [
        {
          catalogSlug: "writing",
          snapshot: { slug: "writing", name: "Catalog writing" },
        },
        {
          catalogSlug: "writing",
          snapshot: { slug: "writing", name: "Second writing" },
        },
        { snapshot: { slug: "private", name: "Private writing" } },
      ],
    });
    render(await Review(props()));
    expect(screen.getByText("Catalog writing")).toBeInTheDocument();
    expect(screen.getByText("Second writing")).toBeInTheDocument();
    expect(screen.getByText("Private writing")).toBeInTheDocument();
    expect(screen.getByText("SEARCH_TOKEN")).toBeInTheDocument();
  });
  it("disallows approving blocked Pi artifacts", async () => {
    m.release.mockResolvedValue(release("pi-package"));
    m.pi.mockReturnValue(packageManifest());
    m.scan.mockReturnValue({ status: "blocked", findings: ["Unsafe archive"] });
    render(await Review(props()));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
      "errorInvalidMarketRelease",
    );
    expect(
      screen.queryByRole("button", { name: "Approve release" }),
    ).not.toBeInTheDocument();
  });
  it.each([
    ["npm", "sha512-integrity"],
    ["git", "commit-deadbeef"],
    ["toolplane", "assembled-package"],
  ])("shows immutable %s provenance", async (kind, expected) => {
    m.release.mockResolvedValue(release("pi-package"));
    m.pi.mockReturnValue(
      packageManifest([], {
        kind,
        requested: "npm:@acme/research",
        name: "assembled-package",
        version: "1.0.0",
        integrity: "sha512-integrity",
        url: "https://example.com/repo",
        commit: "commit-deadbeef",
      }),
    );
    render(await Review(props()));
    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve release" }),
    ).toBeInTheDocument();
  });
  it.each([
    ["YQ==", "a", 1],
    ["YWI=", "ab", 2],
    ["YWJj", "abc", 3],
  ])(
    "previews UTF-8 files and reports decoded size for %s",
    async (content, text, bytes) => {
      m.release.mockResolvedValue(release("pi-package"));
      m.pi.mockReturnValue(
        packageManifest([
          {
            path: "extension.ts",
            type: "file",
            content,
            sha256: "file-hash",
            executable: true,
          },
        ]),
      );
      render(
        await Review(props({ releaseId: "release", path: "extension.ts" })),
      );
      expect(screen.getByText(text, { selector: "pre" })).toBeInTheDocument();
      expect(
        screen.getByText(`${bytes} bytes · SHA-256 file-hash`),
      ).toBeInTheDocument();
      expect(screen.getByText("marketPiPackageExecutable")).toBeInTheDocument();
    },
  );
  it.each([
    Buffer.from([0, 1, 2]).toString("base64"),
    Buffer.from([255, 254]).toString("base64"),
  ])(
    "does not render binary or malformed UTF-8 content as text",
    async (content) => {
      m.release.mockResolvedValue(release("pi-package"));
      m.pi.mockReturnValue(
        packageManifest([
          { path: "extension.ts", type: "file", content, sha256: "hash" },
        ]),
      );
      render(
        await Review(props({ releaseId: "release", path: "extension.ts" })),
      );
      expect(
        screen.getByText("marketPiPackageBinaryPreview"),
      ).toBeInTheDocument();
    },
  );
  it.each([
    ["symlink", "symlink → target.ts"],
    ["directory", "directory"],
  ])(
    "shows %s inventory metadata without treating it as a file",
    async (type, text) => {
      m.release.mockResolvedValue(release("pi-package"));
      m.pi.mockReturnValue(
        packageManifest([{ path: "extension.ts", type, target: "target.ts" }]),
      );
      render(
        await Review(props({ releaseId: "release", path: "extension.ts" })),
      );
      expect(screen.getByText(text)).toBeInTheDocument();
    },
  );
  it("reports a missing selected package file without exposing raw manifests", async () => {
    m.release.mockResolvedValue(release("pi-package"));
    m.pi.mockReturnValue(packageManifest());
    render(await Review(props({ releaseId: "release", path: "missing.ts" })));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "marketPiPackageFileMissing",
    );
    expect(
      screen.queryByText("marketReleaseManifestJson"),
    ).not.toBeInTheDocument();
  });
});
