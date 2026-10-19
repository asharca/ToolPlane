import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EntityCard,
  ScoreStat,
  StarStat,
  formatCount,
} from "@/components/cards/EntityCard";
import { RankedList } from "@/components/RankedList";
import messages from "../../messages/en.json";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) =>
    messages.common[key as keyof typeof messages.common],
}));

describe("public directory display edge cases", () => {
  it("keeps a card navigable when optional content disappears and preserves its ranking", () => {
    const { container, rerender } = render(
      <EntityCard
        href="/server/minimal"
        name="Minimal"
        rank={0}
        category="Utilities"
      />,
    );
    expect(screen.getByRole("link", { name: /Minimal/ })).toHaveAttribute(
      "href",
      "/server/minimal",
    );
    expect(screen.getByText("#0")).toBeInTheDocument();
    expect(screen.getByText("Utilities")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    rerender(<EntityCard href="/server/minimal" name="Minimal" />);
    expect(screen.queryByText("#0")).not.toBeInTheDocument();
    expect(screen.queryByText("Utilities")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Minimal" })).toHaveAttribute(
      "href",
      "/server/minimal",
    );
  });

  it("retains exact accessible counts while abbreviating large visual metrics", () => {
    render(
      <EntityCard
        href="/server/count"
        name="Count"
        stat={
          <>
            <StarStat value={1000} label="Favorites" />
            <ScoreStat value={12500} />
          </>
        }
      />,
    );
    expect(
      screen.getByRole("link", { name: /Favorites: 1,000/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Score: 12,500/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("1k")).toBeInTheDocument();
    expect(screen.getByText("12.5k")).toBeInTheDocument();
    expect(formatCount(999)).toBe("999");
    expect(formatCount(0)).toBe("0");
  });

  it("explains an empty ranking instead of exposing an empty list", async () => {
    render(await RankedList({ title: "Top integrations", items: [] }));
    expect(
      screen.getByRole("heading", { name: "Top integrations" }),
    ).toBeInTheDocument();
    expect(screen.getByText(messages.common.noEntriesYet)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("exposes custom metric labels for ranked entries without icons", async () => {
    const { container } = render(
      await RankedList({
        title: "Most installed",
        items: [
          {
            slug: "minimal",
            name: "Minimal",
            href: "/server/minimal",
            author: null,
            iconUrl: null,
            stat: 1000,
          },
        ],
        statLabel: "Installs",
      }),
    );
    expect(
      screen.getByRole("link", { name: /Minimal.*Installs: 1,000/ }),
    ).toHaveAttribute("href", "/server/minimal");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
