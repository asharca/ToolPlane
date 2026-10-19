import { render, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { LogHealth } from "@/components/admin/LogHealth";

const health = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/health", () => ({ getLogHealth: health }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () =>
    createTranslator({ locale: "en", messages, namespace: "admin" }),
}));
const since = new Date("2026-10-01T01:00:00Z");
const until = new Date("2026-10-01T01:15:00Z");
const empty = {
  since,
  until,
  domains: [],
  abnormal: [],
  deploymentCount: 0,
  writer: { failures: 0, dropped: 0 },
  state: "unknown",
};

describe("administrator logging health", () => {
  it("does not confuse lack of observations with healthy traffic and preserves the sampled time window in drilldowns", async () => {
    health.mockResolvedValue(empty);
    render(await LogHealth({ adminId: "admin" }));
    const links = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/admin/logs?"));
    expect(
      links.map((link) =>
        new URL(
          link.getAttribute("href") ?? "",
          "https://console.example",
        ).searchParams.get("domain"),
      ),
    ).toEqual([
      "http",
      "mcp",
      "a2a",
      "agent",
      "runtime",
      "channel",
      "plugin",
      "system",
    ]);
    for (const link of links) {
      const params = new URL(
        link.getAttribute("href") ?? "",
        "https://console.example",
      ).searchParams;
      expect(Object.fromEntries(params)).toMatchObject({
        tab: "all",
        since: since.toISOString(),
        until: until.toISOString(),
      });
      expect(link).toHaveTextContent("—");
      expect(link).toHaveTextContent("No recent data");
    }
    expect(
      screen.queryByRole("link", { name: "Open system overview" }),
    ).not.toBeInTheDocument();
  });

  it("separates denied requests from errors and bounds abnormal-deployment previews while retaining a full-list link", async () => {
    health.mockResolvedValue({
      ...empty,
      state: "attention",
      domains: [
        { domain: "http", total: 9, errors: 2, denied: 3, last: until },
        { domain: "mcp", total: 4, errors: 0, denied: 1, last: until },
      ],
      deploymentCount: 12,
      abnormal: Array.from({ length: 9 }, (_, i) => ({
        id: `deployment/${i}`,
        name: `Abnormal deployment ${i}`,
        status: "failed",
      })),
      writer: { failures: 1, dropped: 2 },
    });
    render(await LogHealth({ adminId: "admin" }));
    const http = screen
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.includes("domain=http"));
    expect(http).toHaveTextContent("2");
    expect(http).toHaveTextContent("9");
    expect(http).toHaveTextContent("3");
    const first = screen.getByRole("link", { name: /Abnormal deployment 0/ });
    expect(
      new URL(
        first.getAttribute("href") ?? "",
        "https://console.example",
      ).searchParams.get("deploymentId"),
    ).toBe("deployment/0");
    expect(
      screen.getByRole("link", { name: /Abnormal deployment 7/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Abnormal deployment 8")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("status")).getByText(/1.*2/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open system overview" }),
    ).toHaveAttribute("href", "/admin");
  });
});
