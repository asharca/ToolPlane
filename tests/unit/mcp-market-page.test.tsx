import { assertDefined } from "../assert-defined";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getBrowseServers: vi.fn(),
  getDeployments: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getBrowseServers: mocks.getBrowseServers,
  getDeployments: mocks.getDeployments,
}));
vi.mock("@/lib/workspace/actions", () => ({ deployServerAction: vi.fn() }));
vi.mock("@/lib/market/actions", () => ({
  installMarketResourceAction: vi.fn(),
}));

import McpMarketPage from "@/app/app/[workspace]/market/mcp/page";

describe("MCP market type switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      slug: "acme team",
    });
    mocks.getDeployments.mockResolvedValue([]);
    mocks.getBrowseServers.mockResolvedValue({
      featured: [],
      all: [
        {
          id: "connector-1",
          slug: "hosted-search",
          name: "Hosted Search",
          author: "Acme",
          description: "Search through a hosted endpoint.",
          iconUrl: null,
          stars: 12,
          isOfficial: false,
          isFeatured: false,
          createdAt: new Date("2026-08-29T00:00:00.000Z"),
          categories: [{ slug: "search", name: "Search" }],
          mcpKind: "connector",
          marketListing: null,
          deployable: true,
        },
      ],
      total: 30,
      availableTotal: 30,
      pageSize: 25,
      categories: [{ slug: "search", name: "Search", count: 30 }],
    });
  });

  it("keeps the connector type through filters, categories, and pagination", async () => {
    render(
      await McpMarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({
          type: "connector",
          q: "docs",
          category: "search",
          sort: "name",
        }),
      }),
    );

    expect(mocks.getBrowseServers).toHaveBeenCalledWith(1, "docs", {
      category: "search",
      sort: "name",
      type: "connector",
    });
    expect(screen.getByRole("link", { name: "mcpServers" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/mcp?q=docs&sort=name",
    );
    expect(screen.getByRole("link", { name: "mcpConnectors" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/mcp?q=docs&sort=name&type=connector",
    );
    expect(screen.getAllByText("connectorBadge").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /connectToWorkspace/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/mcp?q=docs&category=search&sort=name&page=2&type=connector",
    );
    const form = assertDefined(
      screen.getByRole("button", { name: "applyFilters" }).closest("form"),
    );
    expect(Object.fromEntries(new FormData(form))).toEqual({
      category: "search",
      type: "connector",
      q: "docs",
      sort: "name",
    });
    expect(
      screen.getByRole("link", { name: "manageInstalled" }),
    ).toHaveAttribute("href", "/app/acme%20team/mcp");
  });

  it("keeps server cards informational without an install action", async () => {
    const result = await mocks.getBrowseServers();
    mocks.getBrowseServers.mockResolvedValue({
      ...result,
      all: result.all.map((server: { mcpKind: string }) => ({
        ...server,
        mcpKind: "server",
      })),
    });

    render(
      await McpMarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(
      screen.getByRole("link", { name: "viewDetails" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /addToWorkspace/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connectToWorkspace/ }),
    ).not.toBeInTheDocument();
  });

  it("preserves connector filters returning from page two", async () => {
    render(
      await McpMarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({
          type: "connector",
          page: "2",
          q: "docs",
          category: "search",
          sort: "name",
        }),
      }),
    );
    expect(mocks.getBrowseServers).toHaveBeenCalledWith(2, "docs", {
      category: "search",
      sort: "name",
      type: "connector",
    });
    expect(screen.getByRole("link", { name: "previous" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/mcp?q=docs&category=search&sort=name&type=connector",
    );
    expect(
      new FormData(
        assertDefined(
          screen.getByRole("button", { name: "applyFilters" }).closest("form"),
        ),
      ).has("page"),
    ).toBe(false);
  });

  it("distinguishes a category with no matches from an empty market", async () => {
    const result = await mocks.getBrowseServers();
    mocks.getBrowseServers.mockResolvedValue({ ...result, all: [], total: 0 });
    render(
      await McpMarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({ category: "search" }),
      }),
    );
    expect(screen.getByText("noMcpMatchFilters")).toBeInTheDocument();
    expect(screen.queryByText("noMcpDescription")).not.toBeInTheDocument();
  });
});
