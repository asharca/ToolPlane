import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MarketCatalogManagement,
  MarketListingManagement,
} from "@/components/admin/MarketCatalogManagement";

const mutations = vi.hoisted(() => ({ listing: vi.fn() }));
vi.mock("@/lib/admin/market-catalog-actions", () => ({
  updateMarketListingAdminAction: mutations.listing,
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
const listing = {
  id: "listing-1",
  kind: "assistant",
  publisherKind: "platform",
  namespace: "platform",
  slug: "research",
  name: "Research",
  status: "published",
  curated: true,
  isFeatured: false,
  latestVersion: 3,
  installCount: 10,
  categories: [{ id: "category" }],
  latestRelease: { reviewStatus: "approved" },
  pendingRelease: { version: 4, reviewStatus: "pending" },
};

describe("market catalog administration", () => {
  it("keeps search and the other section's page while navigating listings", () => {
    render(
      <MarketListingManagement
        categories={[]}
        listings={[]}
        page={2}
        pageSize={10}
        total={30}
        q="a & b"
        otherPage={3}
        baseHref="/admin/packages"
      />,
    );
    const links = screen
      .getAllByRole("link")
      .map(
        (link) =>
          new URL(link.getAttribute("href") ?? "", "https://console.example"),
      );
    expect(links.map((url) => url.pathname)).toEqual([
      "/admin/packages",
      "/admin/packages",
    ]);
    expect(links.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { q: "a & b", toolkitPage: "3" },
      { q: "a & b", listingPage: "3", toolkitPage: "3" },
    ]);
  });

  it("offers platform assistant editing and pending release review without losing audit context", () => {
    render(
      <MarketListingManagement
        categories={[]}
        listings={[listing]}
        page={1}
        pageSize={10}
        total={1}
        q=""
      />,
    );
    fireEvent.click(screen.getByText("Research"));
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/admin/assistants/listing-1/edit");
    expect(
      hrefs.some((href) =>
        href?.startsWith("/admin/reviews/market/listing-1?"),
      ),
    ).toBe(true);
    const audit = hrefs.find((href) => href?.startsWith("/admin/logs?"));
    expect(
      new URL(audit ?? "", "https://console.example").searchParams.get(
        "targetId",
      ),
    ).toBe("listing-1");
  });

  it("shows rejected listing saves while retaining category selection", async () => {
    mutations.listing.mockResolvedValueOnce({
      error: "Listing was modified concurrently",
    });
    render(
      <MarketListingManagement
        categories={[
          { id: "category", slug: "research", name: "Research category" },
        ]}
        listings={[
          {
            ...listing,
            kind: "pi-package",
            publisherKind: "user",
            status: "disabled",
            pendingRelease: null,
            latestRelease: null,
          },
        ]}
        page={1}
        pageSize={10}
        total={1}
        q=""
      />,
    );
    fireEvent.click(screen.getByText("Research"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Listing was modified concurrently",
    );
    expect(
      screen.getByRole("checkbox", { name: "Research category" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("link", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("keeps historical Toolkit records read-only with audit access", () => {
    render(
      <MarketCatalogManagement
        categories={[]}
        listings={[]}
        toolkits={[
          {
            id: "toolkit",
            name: "Legacy toolkit",
            slug: "legacy",
            enabled: true,
            categories: [],
            workspace: { name: "Team", slug: "team" },
            _count: { servers: 1, skills: 2 },
          },
        ]}
        listingPage={1}
        listingPageSize={10}
        listingTotal={0}
        toolkitPage={1}
        toolkitPageSize={10}
        toolkitTotal={1}
        q=""
      />,
    );
    fireEvent.click(screen.getByText("Legacy toolkit"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    const audit = screen.getByRole("link", { name: "Change audit" });
    const url = new URL(
      audit.getAttribute("href") ?? "",
      "https://console.example",
    );
    expect(url.searchParams.get("targetId")).toBe("toolkit");
    expect(url.searchParams.get("targetType")).toBe("toolkit");
  });

  it("does not expose mutation or publication controls for historical Toolkit listings", () => {
    render(
      <MarketListingManagement
        categories={[]}
        listings={[{ ...listing, kind: "toolkit" }]}
        page={1}
        pageSize={10}
        total={1}
        q=""
      />,
    );
    fireEvent.click(screen.getByText("Research"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /awaits review/i }),
    ).not.toBeInTheDocument();
    const audit = screen.getByRole("link", { name: "Change audit" });
    expect(
      new URL(
        audit.getAttribute("href") ?? "",
        "https://console.example",
      ).searchParams.get("targetId"),
    ).toBe("listing-1");
  });
});
