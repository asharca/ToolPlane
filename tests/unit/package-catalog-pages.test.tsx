import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  membership: vi.fn(),
  listings: vi.fn(),
  tracking: vi.fn(),
  sources: vi.fn(),
  entries: vi.fn(),
  skills: vi.fn(),
  deployments: vi.fn(),
  browse: vi.fn(),
  categories: vi.fn(),
}));
vi.mock("next/navigation", () => ({
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
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
  getInstalledSkills: m.skills,
  getDeployments: m.deployments,
}));
vi.mock("@/lib/market/skills", () => ({
  listWorkspacePublishedResources: m.listings,
}));
vi.mock("@/lib/market/pi-package-catalog", () => ({
  listPiPackageTracking: m.tracking,
  listPiPackageSources: m.sources,
  listPiPackageSourceEntries: m.entries,
  listPrivateApprovedPiReleases: async () => [],
}));
vi.mock("@/lib/market/listings", () => ({
  listMarketListingCategories: m.categories,
  listMarketListings: m.browse,
}));
vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: async () => [] },
    membership: { findUnique: m.membership },
    marketRelease: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/market/actions", () => ({
  publishPiPackageReleaseAction: vi.fn(),
  publishAssembledPiPackageReleaseAction: vi.fn(),
  publishAssistantReleaseAction: vi.fn(),
  publishMcpReleaseAction: vi.fn(),
  publishSkillReleaseAction: vi.fn(),
  previewPiPackageSourceAction: vi.fn(),
  previewAssembledPiPackageAction: vi.fn(),
  unpublishMarketListingAction: vi.fn(),
  withdrawMarketReleaseAction: vi.fn(),
  installMarketResourceAction: vi.fn(),
}));
vi.mock("@/lib/market/pi-catalog-actions", () => ({
  piCatalogAction: vi.fn(),
}));
vi.mock("@/components/dashboard/market/PiCatalogView", () => ({
  PiCatalogView: () => null,
  PiCatalogNavigation: () => null,
}));
import Packages from "@/app/app/[workspace]/market/compose/page";
import Sources from "@/app/app/[workspace]/market/sources/page";
import Market from "@/app/app/[workspace]/market/pi-packages/page";
import Toolkits from "@/app/app/[workspace]/market/toolkits/page";
const props = (query = {}) => ({
  params: Promise.resolve({ workspace: "acme" }),
  searchParams: Promise.resolve(query),
});
const listing = (patch = {}) => ({
  id: "pkg",
  kind: "pi-package",
  namespace: "acme",
  slug: "research",
  name: "Research package",
  summary: "Research utilities",
  metadata: null,
  tags: [],
  categories: [],
  visibility: "private",
  status: "draft",
  releases: [],
  pendingRelease: null,
  latestRelease: null,
  ...patch,
});
const source = (patch = {}) => ({
  id: "source-1",
  kind: "npm",
  name: "Corporate registry",
  url: "https://registry.example.com",
  hasCredentials: false,
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: "user", timeZone: "UTC" });
  m.workspace.mockResolvedValue({ id: "ws", ownerId: "user", slug: "acme" });
  m.membership.mockResolvedValue(null);
  m.listings.mockResolvedValue([]);
  m.tracking.mockResolvedValue([]);
  m.sources.mockResolvedValue([]);
  m.entries.mockResolvedValue({ entries: [], hasMore: false });
  m.skills.mockResolvedValue([]);
  m.deployments.mockResolvedValue([]);
  m.categories.mockResolvedValue([]);
  m.browse.mockResolvedValue({
    items: [],
    total: 0,
    availableTotal: 0,
    categories: [],
    pageSize: 24,
  });
});
afterEach(cleanup);
describe("package workspace and source pages", () => {
  it.each([Packages, Sources, Market])(
    "requires authentication before retrieving workspace data",
    async (page) => {
      m.user.mockResolvedValue(null);
      await expect(page(props())).rejects.toThrow("redirect:/app/login");
      expect(m.workspace).not.toHaveBeenCalled();
    },
  );
  it.each([Packages, Sources, Market])(
    "redirects inaccessible workspaces",
    async (page) => {
      m.workspace.mockResolvedValue(null);
      await expect(page(props())).rejects.toThrow("redirect:/app");
    },
  );
  it("does not offer historical Toolkit conversion in normal package assembly", async () => {
    render(await Packages(props()));
    expect(
      screen.queryByRole("combobox", { name: "packageExistingToolkit" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("piComposeDescription")).toBeInTheDocument();
  });
  it("describes an empty package workspace and provides source and market navigation", async () => {
    render(await Packages(props()));
    expect(screen.getByText("workspaceEmptyHelp")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sourcesTitle" })).toHaveAttribute(
      "href",
      "/app/acme/market/sources",
    );
  });
  it.each([
    ["draft", null, "publicationNotPublished"],
    ["disabled", null, "publicationDisabled"],
    ["published", { id: "release", version: 2 }, "publicationPublished:2"],
  ])(
    "presents %s publication state and only available artifacts",
    async (status, release, text) => {
      m.listings.mockResolvedValue([
        listing({ status, latestRelease: release }),
      ]);
      render(await Packages(props()));
      expect(screen.getByText(text)).toBeInTheDocument();
      if (release)
        expect(
          screen.getByRole("link", { name: "piArtifactDownload" }),
        ).toHaveAttribute(
          "href",
          "/api/v1/workspaces/acme/market/pi-packages/release/download",
        );
      else
        expect(
          screen.queryByRole("link", { name: "piArtifactDownload" }),
        ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "reviewInstall" }) !== null,
      ).toBe(status === "published");
    },
  );
  it("shows pending review and rejected feedback while excluding official and unrelated resources", async () => {
    m.listings.mockResolvedValue([
      listing({
        pendingRelease: { id: "pending", version: 3, reviewStatus: "pending" },
        releases: [
          {
            reviewStatus: "rejected",
            reviewNote: "Remove embedded credentials",
          },
        ],
      }),
      listing({
        id: "official",
        name: "Official hidden",
        metadata: { officialPiPackageName: "official" },
      }),
      listing({ id: "other", kind: "skill", name: "Not a package" }),
    ]);
    render(await Packages(props()));
    expect(screen.getByText("publicationPending:3")).toBeInTheDocument();
    expect(screen.getByText("Remove embedded credentials")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "withdrawSubmission" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Official hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Not a package")).not.toBeInTheDocument();
  });
  it("searches package names and slugs case-insensitively", async () => {
    m.listings.mockResolvedValue([
      listing(),
      listing({ id: "other", name: "Unrelated", slug: "other" }),
    ]);
    render(await Packages(props({ q: " RESEARCH " })));
    expect(
      screen.getByRole("heading", { name: "Research package" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Unrelated" }),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("RESEARCH")).toBeInTheDocument();
  });
  it.each(["error", "suspicious", "update_available", "current"])(
    "shows %s upstream tracking and offers appropriate recovery actions",
    async (status) => {
      m.listings.mockResolvedValue([listing()]);
      m.tracking.mockResolvedValue([
        {
          listingId: "pkg",
          requested: "npm:@acme/research",
          mode: "auto",
          status,
          latestIdentity: status === "current" ? null : "identity-2",
          latestVersion: status === "error" ? null : "2.0.0",
          checkedAt: status === "current" ? null : "2026-08-01",
        },
      ]);
      render(await Packages(props()));
      expect(screen.getByText(/npm:@acme\/research/)).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "captureNew" }),
      ).toBeInTheDocument();
      if (status === "error" || status === "suspicious")
        expect(screen.getByRole("alert")).toHaveTextContent(
          status === "error" ? "checkFailed" : "suspicious",
        );
      expect(
        screen.queryByRole("button", { name: "dismissVersion" }) !== null,
      ).toBe(status === "update_available");
    },
  );
  it("does not offer publisher-only capture and dismiss operations to ordinary members", async () => {
    m.workspace.mockResolvedValue({ id: "ws", ownerId: "other" });
    m.membership.mockResolvedValue({ role: "member" });
    m.listings.mockResolvedValue([listing()]);
    m.tracking.mockResolvedValue([
      {
        listingId: "pkg",
        requested: "npm:pkg",
        mode: "manual",
        status: "update_available",
        latestIdentity: "next",
      },
    ]);
    render(await Packages(props()));
    expect(
      screen.queryByRole("link", { name: "captureNew" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "dismissVersion" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "checkOne" }),
    ).toBeInTheDocument();
  });
  it("explains missing sources and rejects unknown selected sources visibly", async () => {
    render(await Sources(props({ source: "missing" })));
    expect(screen.getByText("noSources")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "errors.source_not_found",
    );
    expect(m.entries).not.toHaveBeenCalled();
  });
  it("hides source editing and registry publication from non-managers", async () => {
    m.workspace.mockResolvedValue({ id: "ws", ownerId: "other" });
    m.membership.mockResolvedValue({ role: "member" });
    m.sources.mockResolvedValue([source()]);
    render(await Sources(props({ source: "source-1" })));
    expect(screen.queryByText("editSource")).not.toBeInTheDocument();
    expect(screen.queryByText("addSource")).not.toBeInTheDocument();
    expect(screen.getAllByText("managerRequired").length).toBeGreaterThan(0);
  });
  it.each([
    ["npm", true],
    ["git", false],
  ])(
    "renders %s discovery and keeps pagination scoped to the source and query",
    async (kind, credentials) => {
      m.sources.mockResolvedValue([
        source({ kind, hasCredentials: credentials }),
        source({ id: "other", name: "Other source" }),
      ]);
      m.entries.mockResolvedValue({
        entries: [
          {
            name: "Research extension",
            source: "npm:@acme/research",
            description: "Research catalog entry",
            version: "2.0.0",
          },
        ],
        hasMore: true,
      });
      render(
        await Sources(
          props({ source: "source-1", q: " research ", page: "2" }),
        ),
      );
      expect(
        screen.getByRole("heading", { name: "Research extension" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Corporate registry" }),
      ).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: "previous" })).toHaveAttribute(
        "href",
        "/app/acme/market/sources?source=source-1&q=research&page=1",
      );
      expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
        "href",
        "/app/acme/market/sources?source=source-1&q=research&page=3",
      );
      expect(
        screen.getByText(
          new RegExp(credentials ? "credentialsConfigured" : "noCredentials"),
        ),
      ).toBeInTheDocument();
    },
  );
  it("presents discovery failure without leaking upstream errors", async () => {
    m.sources.mockResolvedValue([source()]);
    m.entries.mockRejectedValue(new Error("Secret upstream credentials"));
    render(await Sources(props({ source: "source-1", page: "NaN" })));
    expect(screen.getByRole("alert")).toHaveTextContent("discoveryFailed");
    expect(
      screen.queryByText("Secret upstream credentials"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "previous" }),
    ).not.toBeInTheDocument();
  });
});
describe("market packages and toolkits", () => {
  it("redirects the legacy workspace package view to management", async () => {
    await expect(Market(props({ view: "workspace" }))).rejects.toThrow(
      "redirect:/app/acme/market/compose",
    );
  });
  it.each([Market])(
    "drops unknown category filters while retaining search and sort",
    async (page) => {
      await expect(
        page(
          props({
            view: "toolplane",
            q: [" research "],
            category: ["missing"],
            sort: ["name"],
          }),
        ),
      ).rejects.toThrow(/redirect:.*q=research.*sort=name/);
    },
  );
  it.each([Market])(
    "clamps out-of-range pagination without discarding category filters",
    async (page) => {
      m.categories.mockResolvedValue([
        { slug: "research", name: "Research", count: 25 },
      ]);
      m.browse.mockResolvedValue({
        items: [],
        total: 25,
        availableTotal: 25,
        pageSize: 24,
        categories: [{ slug: "research", name: "Research", count: 25 }],
      });
      await expect(
        page(
          props({
            view: "toolplane",
            page: "99",
            category: "research",
            sort: "name",
          }),
        ),
      ).rejects.toThrow(/redirect:.*category=research.*sort=name.*page=2/);
    },
  );
  it.each([
    [{}, "piEmptyDescription"],
    [{ q: "missing" }, "piNoMatches"],
  ])(
    "distinguishes empty package catalogs from filtered misses",
    async (query, text) => {
      render(await Market(props({ view: "toolplane", ...query })));
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "piPublishTitle" }),
      ).toHaveAttribute("href", "/app/acme/market/compose");
    },
  );
  it("renders released market packages only and preserves encoded details links", async () => {
    m.browse.mockResolvedValue({
      items: [
        listing({
          latestRelease: { version: 2 },
          installCount: 8,
          summary: null,
        }),
        listing({ id: "hidden", name: "Unreleased package" }),
      ],
      total: 2,
      availableTotal: 2,
      pageSize: 24,
    });
    render(await Market(props({ view: "toolplane" })));
    expect(
      screen.getByRole("link", { name: "Research package" }),
    ).toHaveAttribute("href", "/app/acme/market/items/acme/research");
    expect(screen.getByText("noDescription")).toBeInTheDocument();
    expect(screen.queryByText("Unreleased package")).not.toBeInTheDocument();
  });
  it("redirects retired Toolkit discovery to package discovery without execution", async () => {
    await expect(
      Toolkits({ params: Promise.resolve({ workspace: "acme" }) }),
    ).rejects.toThrow("redirect:/app/acme/market?type=pi-package");
    expect(m.browse).not.toHaveBeenCalled();
  });
  it("allows workspace administrators to act on detected upstream updates", async () => {
    m.workspace.mockResolvedValue({ id: "ws", ownerId: "other" });
    m.membership.mockResolvedValue({ role: "admin" });
    m.listings.mockResolvedValue([listing()]);
    m.tracking.mockResolvedValue([
      {
        listingId: "pkg",
        requested: "npm:pkg",
        mode: "manual",
        status: "update_available",
        latestIdentity: "next",
      },
    ]);
    render(await Packages(props()));
    expect(
      screen.getByRole("button", { name: "dismissVersion" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "captureNew" }),
    ).toBeInTheDocument();
  });
});
