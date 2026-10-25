import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  ToolkitsBrowser,
  type ToolkitRow,
} from "@/components/dashboard/ToolkitsBrowser";

const toolkits: ToolkitRow[] = [
  {
    id: "toolkit-1",
    name: "Research stack",
    slug: "research-stack",
    visibility: "private",
    enabled: true,
    toolCount: 3,
    created: "Jul 15, 2026",
  },
  {
    id: "toolkit-2",
    name: "Public utilities",
    slug: "public-utilities",
    visibility: "public",
    enabled: false,
    toolCount: 1,
    created: "Jul 14, 2026",
  },
];

describe("read-only Toolkit history", () => {
  it("links historical records without create, publish, or execution controls", async () => {
    const { container } = render(
      <ToolkitsBrowser slug="acme" toolkits={toolkits} />,
    );
    expect(
      await screen.findByRole("link", { name: "Research stack" }),
    ).toHaveAttribute("href", "/app/acme/toolkits/research-stack");
    expect(
      screen.getByRole("link", { name: "New Pi package" }),
    ).toHaveAttribute("href", "/app/acme/market/compose");
    expect(screen.getByText(/Historical configuration only/)).toBeVisible();
    expect(container.querySelector("form")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /New Toolkit|Publish|Enable|Disable/,
      }),
    ).not.toBeInTheDocument();
  });

  it("searches historical records and keeps saved state distinct from execution", async () => {
    const user = userEvent.setup();
    render(<ToolkitsBrowser slug="acme" toolkits={toolkits} />);
    for (const name of [
      "Toolkit",
      "Historical configuration",
      "Tools",
      "Created",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(await screen.findByText("Private · Enabled")).toBeVisible();
    expect(screen.getByText("Public · Disabled")).toBeVisible();
    await user.type(
      screen.getByPlaceholderText("Search toolkits..."),
      "missing",
    );
    expect(
      screen.getByText("No historical Toolkit resources match this view."),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Research stack" }),
    ).not.toBeInTheDocument();
  });
});
