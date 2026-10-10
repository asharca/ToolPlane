import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", async () => {
  const en = (await import("../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function getNs(ns: string): Record<string, string> {
    let obj: unknown = en;
    for (const part of ns.split("."))
      obj = (obj as Record<string, unknown>)[part];
    return obj as Record<string, string>;
  }
  return {
    useTranslations: (ns: string) => (k: string) => getNs(ns)[k] ?? k,
    useLocale: () => "en",
  };
});

import { Header } from "@/components/layout/Header";

describe("Header", () => {
  it("renders desktop and mobile navigation with a stable console entry", async () => {
    render(<Header />);

    expect(screen.getByRole("link", { name: /ToolPlane/ })).toHaveAttribute(
      "href",
      "/",
    );
    for (const [name, href] of [
      ["MCP runtime", "/server"],
      ["Skills", "/tools/skills"],
      ["Agents", "/agents"],
      ["Integrations", "/client"],
      ["Open console", "/app"],
    ]) {
      expect(
        screen
          .getAllByRole("link", { name })
          .every((link) => link.getAttribute("href") === href),
      ).toBe(true);
    }
    const menu = screen.getByRole("button", { name: "Menu" });
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });
});
