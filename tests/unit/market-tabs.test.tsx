import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketTabs } from "@/components/dashboard/MarketTabs";

const mocks = vi.hoisted(() => ({
  pathname: "/app/acme/market/installed",
  search: "",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

describe("Resource Center lifecycle navigation", () => {
  beforeEach(() => {
    mocks.pathname = "/app/acme/market/installed";
    mocks.search = "";
  });

  it("has four lifecycle tabs rather than a second resource type navigation layer", () => {
    render(<MarketTabs slug="acme" />);
    const tabs = within(
      screen.getByRole("navigation", { name: "Resource Center sections" }),
    );
    const entries = [
      ["Discover", "/app/acme/market"],
      ["Workspace resources", "/app/acme/market/installed"],
      ["Updates", "/app/acme/market/installed?updates=1"],
      ["My publications", "/app/acme/market/publish"],
    ];
    for (const [name, href] of entries) {
      expect(tabs.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(tabs.getAllByRole("link")).toHaveLength(4);
    expect(
      screen.queryByRole("link", { name: "Toolkits" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["/market/items/acme/research", "Discover"],
    ["/market/installed/install/clients", "Workspace resources"],
    ["/market/sources", "Workspace resources"],
    ["/market/compose", "My publications"],
    ["/market/publish", "My publications"],
  ])("maps nested %s to %s", (route, name) => {
    mocks.pathname = `/app/acme${route}`;
    render(<MarketTabs slug="acme" />);
    expect(screen.getByRole("link", { name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("shows update counts on the active Updates tab", () => {
    mocks.search = "updates=1";
    render(<MarketTabs slug="acme" updateCount={2} />);
    expect(screen.getByRole("link", { name: "Updates 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Workspace resources" }),
    ).not.toHaveAttribute("aria-current");
  });
});
