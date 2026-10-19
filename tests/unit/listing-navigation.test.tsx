import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ListingHero } from "@/components/ListingHero";
import { Pagination } from "@/components/Pagination";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

describe("directory listing navigation", () => {
  it.each([0, 1])("omits pagination for %i pages", async (totalPages) => {
    const { container } = render(
      await Pagination({
        page: 1,
        totalPages,
        basePath: "/skills",
        pagePath: "/skills/page",
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables backward navigation on the first page and uses the unpaged root", async () => {
    render(
      await Pagination({
        page: 1,
        totalPages: 10,
        basePath: "/skills",
        pagePath: "/skills/page",
      }),
    );
    expect(screen.getByRole("button", { name: "previous" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute(
      "href",
      "/skills",
    );
    expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
      "href",
      "/skills/page/2",
    );
    expect(screen.getByRole("link", { name: "10" })).toHaveAttribute(
      "href",
      "/skills/page/10",
    );
    expect(screen.queryByRole("link", { name: "4" })).not.toBeInTheDocument();
  });

  it("keeps both ends reachable from a middle window with a custom query builder", async () => {
    render(
      await Pagination({
        page: 5,
        totalPages: 10,
        hrefForPage: (page) => `/search?q=tools&page=${page}`,
      }),
    );
    for (const page of [1, 3, 4, 5, 6, 7, 10]) {
      expect(screen.getByRole("link", { name: String(page) })).toHaveAttribute(
        "href",
        `/search?q=tools&page=${page}`,
      );
    }
    expect(screen.getAllByText("…")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "previous" })).toHaveAttribute(
      "href",
      "/search?q=tools&page=4",
    );
    expect(screen.getByRole("link", { name: "next" })).toHaveAttribute(
      "href",
      "/search?q=tools&page=6",
    );
  });

  it("disables forward navigation at the last page", async () => {
    render(
      await Pagination({
        page: 4,
        totalPages: 4,
        basePath: "/skills",
        pagePath: "/skills/page",
      }),
    );
    expect(screen.getByRole("button", { name: "next" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "previous" })).toHaveAttribute(
      "href",
      "/skills/page/3",
    );
    expect(screen.getByRole("link", { name: "4" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  const hero = {
    lead: "Find",
    tail: "tools",
    subtitle: "Browse tools",
    placeholder: "Search tools",
  };

  it("encodes default category URLs and selects All without an active category", async () => {
    const { container } = render(
      await ListingHero({
        ...hero,
        categories: [{ slug: "code & data", name: "Code" }],
      }),
    );
    expect(screen.getByRole("link", { name: "all" })).toHaveAttribute(
      "href",
      "/categories",
    );
    expect(screen.getByRole("link", { name: "all" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Code" })).toHaveAttribute(
      "href",
      "/categories/code%20%26%20data",
    );
    expect(screen.getByRole("link", { name: "Code" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(container.querySelector("form")).toHaveAttribute(
      "action",
      "/search",
    );
  });

  it("preserves search filters, omits nullish hidden fields, and caps categories at eight", async () => {
    const categories = Array.from({ length: 10 }, (_, index) => ({
      slug: `cat-${index}`,
      name: `Category ${index}`,
    }));
    const { container } = render(
      await ListingHero({
        ...hero,
        categories,
        searchAction: "/tools/skills",
        defaultSearchValue: "safe & useful",
        activeCategory: "cat-2",
        categoryHref: (slug) => `/tools/skills?category=${slug ?? "all"}`,
        hiddenFields: {
          kind: "skill",
          page: 0,
          verified: false,
          missing: null,
          absent: undefined,
        },
      }),
    );
    const search = screen.getByRole("searchbox", { name: "Search tools" });
    expect(search).toHaveValue("safe & useful");
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("action", "/tools/skills");
    expect(Object.fromEntries(new FormData(form as HTMLFormElement))).toEqual({
      q: "safe & useful",
      kind: "skill",
      page: "0",
      verified: "false",
    });
    const nav = screen.getByRole("navigation", { name: "browseCategories" });
    expect(within(nav).getAllByRole("link")).toHaveLength(9);
    expect(
      screen.queryByRole("link", { name: "Category 8" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Category 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "all" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("still renders a searchable listing without categories", async () => {
    render(await ListingHero({ ...hero, categories: [] }));
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });
});
