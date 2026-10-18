import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  admin: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  manifest: vi.fn(),
  release: vi.fn(),
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
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: m.admin }));
vi.mock("@/lib/admin/agent-market", () => ({
  ADMIN_AGENT_LISTING_STATUSES: ["draft", "published", "disabled"],
  listDirectoryAgentListings: m.list,
  getDirectoryAgentListing: m.detail,
  readAgentReleaseManifest: m.manifest,
  listCatalogAgentResources: async () => ({
    servers: [{ id: "server", slug: "search", name: "Search server" }],
    skills: [{ id: "skill", slug: "writing", name: "Writing skill" }],
  }),
}));
vi.mock("@/lib/admin/agent-market-actions", () => ({
  deleteAgentListingAction: vi.fn(),
  rejectAgentReleaseAction: vi.fn(),
  setAgentListingStatusAction: vi.fn(),
  updateAgentListingAction: vi.fn(),
}));
vi.mock("@/lib/admin/categories", () => ({
  listCategories: async () => [{ id: "cat", name: "Research" }],
}));
vi.mock("@/lib/db", () => ({ db: { agentRelease: { findFirst: m.release } } }));
vi.mock("@/components/admin/ReleaseChanges", () => ({
  ReleaseChanges: () => null,
}));
vi.mock("@/components/admin/AgentReleaseReview", () => ({
  AgentReleaseReview: () => null,
}));
import List from "@/app/admin/agents/page";
import Edit from "@/app/admin/agents/[id]/edit/page";
const props = (query = {}) => ({
  params: Promise.resolve({ id: "listing" }),
  searchParams: Promise.resolve(query),
});
const listing = (patch = {}) => ({
  id: "listing",
  directorySlug: "research",
  name: "Research agent",
  author: null,
  summary: "Focused research",
  iconUrl: null,
  tags: [],
  curated: false,
  isFeatured: false,
  categories: [],
  status: "draft",
  publisherKind: "administrator",
  publisherWorkspaceId: null,
  publisherWorkspace: null,
  latestVersion: 0,
  installCount: 0,
  pendingRelease: null,
  latestRelease: null,
  releases: [],
  ...patch,
});
const manifest = (patch = {}) => ({
  rootAgentKey: "root",
  agents: [
    {
      key: "root",
      name: "Research agent",
      systemPrompt: "Research carefully",
      maxSteps: 12,
      modelRequirement: { format: "openai", model: "research-model" },
      subAgentKeys: [],
    },
  ],
  deployments: [{ catalogSlug: "search" }],
  skills: [{ origin: "catalog", catalogSlug: "writing" }],
  toolkits: [],
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue({ id: "admin" });
  m.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  m.detail.mockResolvedValue(listing());
  m.manifest.mockReturnValue(manifest());
  m.release.mockResolvedValue(null);
});
afterEach(cleanup);
describe("admin agent listing navigation and configuration safety", () => {
  it.each([List, Edit])(
    "blocks unauthorized administrators before querying listings",
    async (page) => {
      m.admin.mockRejectedValue(new Error("Admin required"));
      await expect(page(props())).rejects.toThrow("Admin required");
      expect(m.list).not.toHaveBeenCalled();
      expect(m.detail).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{}, "emptyAgentListingsDescription"],
    [{ q: "search" }, "noAgentListingsDescription"],
    [{ status: "draft" }, "noAgentListingsDescription"],
  ])("explains empty listing results", async (query, text) => {
    render(await List(props(query)));
    expect(screen.getByText(text)).toBeInTheDocument();
  });
  it("canonicalizes invalid status, whitespace and page while preserving normalized query", async () => {
    await expect(
      List(props({ q: " research ", page: "NaN", status: "bogus" })),
    ).rejects.toThrow("redirect:/admin/agents?page=1&q=research");
  });
  it("clamps expired pages while preserving status filters", async () => {
    m.list.mockResolvedValue({ items: [], total: 21, page: 99, pageSize: 20 });
    await expect(
      List(props({ page: "99", status: "published" })),
    ).rejects.toThrow("redirect:/admin/agents?page=2&status=published");
  });
  it("renders publication status, pending versions and orphaned publishers with filter-preserving edit links", async () => {
    m.list.mockResolvedValue({
      items: [
        listing({
          status: "published",
          author: "Ada",
          isFeatured: true,
          curated: true,
          latestVersion: 2,
          pendingRelease: { version: 3 },
        }),
        listing({
          id: "orphan",
          name: "Orphaned agent",
          status: "disabled",
          publisherKind: "workspace",
        }),
        listing({
          id: "workspace",
          name: "Workspace agent",
          publisherKind: "workspace",
          publisherWorkspaceId: "ws",
          publisherWorkspace: { name: "Acme", slug: "acme" },
        }),
      ],
      total: 25,
      page: 1,
      pageSize: 20,
    });
    await act(async () => {
      render(await List(props({ q: "agent", status: "published" })));
    });
    expect(
      screen.getByText("agentPublisherWorkspaceRemoved"),
    ).toBeInTheDocument();
    expect(screen.getByText("agentPublisherMissing")).toBeInTheDocument();
    expect(screen.getByText("agentPendingVersion:3")).toBeInTheDocument();
    expect(screen.getByText("featured")).toBeInTheDocument();
    expect(screen.getByText("curated")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Research agent" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/agents/listing/edit?returnTo="),
    );
    expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
      "href",
      "/admin/agents?page=2&q=agent&status=published",
    );
  });
  it("returns notFound for a missing listing", async () => {
    m.detail.mockResolvedValue(null);
    await expect(Edit(props())).rejects.toThrow("notFound");
  });
  it("returns notFound when a requested historical release does not belong to this listing", async () => {
    await expect(Edit(props({ releaseId: "missing" }))).rejects.toThrow(
      "notFound",
    );
  });
  it("allows creating initial configuration and publishing a draft", async () => {
    render(await Edit(props()));
    expect(
      screen.getByRole("textbox", { name: "System prompt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "publishAgentListing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("agentNoReleases")).toBeInTheDocument();
  });
  it("loads simple catalog-only configurations into editable form selections", async () => {
    m.detail.mockResolvedValue(
      listing({
        status: "published",
        latestRelease: { manifest: {}, checksum: "hash" },
      }),
    );
    render(await Edit(props()));
    expect(screen.getByDisplayValue("Research carefully")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /Search server/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Writing skill/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "disableAgentListing" }),
    ).toBeInTheDocument();
  });
  it.each([
    { agents: [] },
    { agents: [{ key: "root", subAgentKeys: ["child"] }] },
    {
      agents: [
        { key: "root", subAgentKeys: [] },
        { key: "child", subAgentKeys: [] },
      ],
    },
    { toolkits: [{ key: "tk" }] },
    { skills: [{ origin: "snapshot" }] },
    { deployments: [{ catalogSlug: "missing" }] },
    { skills: [{ origin: "catalog", catalogSlug: "missing" }] },
  ])(
    "locks complex or unresolved configuration rather than losing resources",
    async (patch) => {
      m.detail.mockResolvedValue(
        listing({ latestRelease: { manifest: {}, checksum: "hash" } }),
      );
      m.manifest.mockReturnValue(manifest(patch));
      render(await Edit(props()));
      expect(
        screen.getByText(
          /This release contains a complex or community-authored graph/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "System prompt" }),
      ).not.toBeInTheDocument();
    },
  );
  it("locks corrupt releases and shows an explicit rejection action for the current pending release", async () => {
    m.detail.mockResolvedValue(
      listing({
        pendingRelease: {
          id: "pending",
          version: 3,
          reviewStatus: "pending",
          manifest: {},
          checksum: "bad",
        },
      }),
    );
    m.manifest.mockImplementation(() => {
      throw new Error("Checksum mismatch");
    });
    render(await Edit(props()));
    expect(
      screen.getByText("agentInvalidPendingReleaseDescription"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "agentRejectRelease" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /This release contains a complex or community-authored graph/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checksum mismatch")).not.toBeInTheDocument();
  });
  it("does not allow rejecting an already reviewed historical corrupt release", async () => {
    m.release
      .mockResolvedValueOnce({
        id: "old",
        version: 1,
        reviewStatus: "rejected",
        reviewNote: "Invalid old archive",
        manifest: {},
        checksum: "bad",
      })
      .mockResolvedValue(null);
    m.manifest.mockImplementation(() => {
      throw new Error("invalid");
    });
    render(
      await Edit(
        props({ releaseId: "old", returnTo: "/admin/agents?status=disabled" }),
      ),
    );
    expect(
      screen.getByText("rejected: Invalid old archive"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "agentRejectRelease" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "directoryAgents" }),
    ).toHaveAttribute("href", "/admin/agents?status=disabled");
  });
});
