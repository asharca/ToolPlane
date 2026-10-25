import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listMarketListings: vi.fn(),
  listWorkspaceMarketInstalls: vi.fn(),
  effectiveStatus: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
}));
vi.mock("@/lib/market/listings", () => ({
  listMarketListings: mocks.listMarketListings,
}));
vi.mock("@/lib/market/skills", () => ({
  listWorkspaceMarketInstalls: mocks.listWorkspaceMarketInstalls,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: mocks.effectiveStatus,
}));

import MarketPage from "@/app/app/[workspace]/market/page";

describe("workspace market Discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({
      id: "workspace-1",
      slug: "acme team",
    });
    mocks.listMarketListings.mockResolvedValue({
      items: [],
      total: 0,
      pageSize: 18,
    });
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([]);
  });

  it("renders Discover and resource import instead of forwarding to a directory", async () => {
    render(
      await MarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(
      screen.getByRole("heading", { name: "discoverTitle" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "importResource" }),
    ).toHaveAttribute("href", "/app/acme%20team/market/import");
    expect(screen.getByText("noPublishedResources")).toBeInTheDocument();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.listMarketListings).toHaveBeenCalledWith({
      kind: "",
      q: "",
      sourceKind: "",
      target: undefined,
      page: 1,
      pageSize: 18,
      viewer: { workspaceId: "workspace-1", userId: "user-1" },
    });
    expect(mocks.listWorkspaceMarketInstalls).toHaveBeenCalledWith(
      "workspace-1",
    );
  });

  it("filters published resources and shows tracked skill installation state with detail navigation", async () => {
    mocks.listMarketListings.mockResolvedValue({
      items: [
        {
          id: "listing-1",
          kind: "skill",
          namespace: "acme labs",
          slug: "release-writer",
          name: "Release writer",
          summary: "Writes reviewed releases.",
          sourceKind: "git",
          latestRelease: { id: "release-2", version: 2 },
        },
      ],
      total: 54,
      pageSize: 18,
    });
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([
      {
        listingId: "listing-1",
        currentRelease: { id: "release-1", version: 1 },
        status: "modified",
        updateAvailable: true,
      },
    ]);

    render(
      await MarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({
          q: "  release  ",
          type: "skill",
          sourceKind: "git",
          target: "agent",
          page: "2",
        }),
      }),
    );

    expect(mocks.listMarketListings).toHaveBeenCalledWith({
      kind: "skill",
      q: "release",
      sourceKind: "git",
      target: "agent",
      page: 2,
      pageSize: 18,
      viewer: { workspaceId: "workspace-1", userId: "user-1" },
    });
    expect(screen.getByRole("textbox", { name: "search" })).toHaveValue(
      "release",
    );
    expect(screen.getByRole("combobox", { name: "resourceTypes" })).toHaveValue(
      "skill",
    );
    expect(
      screen.getByRole("combobox", { name: "sourceKindLabel" }),
    ).toHaveValue("git");
    expect(
      screen.getByRole("combobox", { name: "compatibleTarget" }),
    ).toHaveValue("agent");
    expect(
      screen.getByRole("heading", { name: "Release writer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Writes reviewed releases.")).toBeInTheDocument();
    expect(
      screen.getByText(/installedResources.*statusModified.*updateAvailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "viewDetails" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/items/acme%20labs/release-writer",
    );
    expect(screen.getByRole("link", { name: "previous" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market?q=release&type=skill&sourceKind=git&target=agent&page=1",
    );
    expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market?q=release&type=skill&sourceKind=git&target=agent&page=3",
    );
  });
  it("opens Agent templates through their dedicated listing route", async () => {
    mocks.listMarketListings.mockResolvedValue({
      items: [
        {
          id: "agent listing",
          kind: "agent",
          namespace: "acme labs",
          slug: "reviewer",
          name: "Reviewer",
          summary: null,
          sourceKind: "workspace",
          latestRelease: { id: "release", version: 1 },
        },
      ],
      total: 1,
      pageSize: 18,
    });
    render(
      await MarketPage({
        params: Promise.resolve({ workspace: "acme team" }),
        searchParams: Promise.resolve({ type: "agent" }),
      }),
    );
    expect(screen.getByRole("link", { name: "viewDetails" })).toHaveAttribute(
      "href",
      "/app/acme%20team/market/agents/agent%20listing",
    );
  });
});
