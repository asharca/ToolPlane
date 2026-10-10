import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PiPackageComposeForm } from "@/components/dashboard/market/SkillPublishForm";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/market/actions", () => ({
  publishPiPackageReleaseAction: vi.fn(),
  publishAssembledPiPackageReleaseAction: vi.fn(),
  publishAssistantReleaseAction: vi.fn(),
  publishMcpReleaseAction: vi.fn(),
  publishSkillReleaseAction: vi.fn(),
  publishToolkitReleaseAction: vi.fn(),
}));

describe("Pi package composition", () => {
  it("prefills Toolkit resources while keeping the new package selection editable and independent", async () => {
    const user = userEvent.setup();
    render(
      <PiPackageComposeForm
        workspace="acme"
        canPublish
        categories={[]}
        resource={{
          id: "toolkit",
          name: "Research",
          slug: "research",
          description: null,
        }}
        options={{
          skills: [
            { id: "included", name: "Included skill", selected: true },
            { id: "other", name: "Other skill" },
          ],
          deployments: [
            {
              id: "search-mcp",
              name: "Search MCP",
              tools: ["search", "lookup"],
              selected: true,
            },
            { id: "write-mcp", name: "Write MCP", tools: ["write"] },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "piComposeTitle" }));
    const included = await screen.findByRole("checkbox", {
      name: "Included skill",
    });
    expect(included).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Other skill" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "search" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "lookup" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "write" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "lookup" }));
    const form = included.closest("form");
    if (!form) throw new Error("Composition form missing");
    const submitted = new FormData(form);
    expect(submitted.getAll("installedSkillIds")).toEqual(["included"]);
    expect(
      submitted.getAll("mcpTools").map((value) => JSON.parse(String(value))),
    ).toEqual([["search-mcp", "search"]]);
    expect(submitted.get("packageName")).toBe("research");
    expect(submitted.get("name")).toBe("Research");
    expect(submitted.get("listingId")).toBe("");
    expect(submitted.has("toolkitId")).toBe(false);
  });
});
