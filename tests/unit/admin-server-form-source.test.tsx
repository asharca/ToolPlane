import { assertDefined } from "../assert-defined";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchMetadata: vi.fn() }));

vi.mock("@/lib/admin/market-actions", () => ({
  fetchServerSourceMetadataAction: mocks.fetchMetadata,
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import { ServerForm } from "@/components/admin/ServerForm";

describe("ServerForm source metadata", () => {
  it("can fetch package metadata and keeps the canonical source URL for saving", () => {
    const { container } = render(
      <ServerForm
        action={vi.fn().mockResolvedValue({})}
        initial={{ sourceUrl: "https://github.com/acme/catalog-mcp" }}
        categories={[]}
        submitLabel="Create"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Fetch metadata" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Source URL" })).toHaveValue(
      "https://github.com/acme/catalog-mcp",
    );
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.get("sourceMetadataCanonicalUrl")).toBe(
      "https://github.com/acme/catalog-mcp",
    );
  });

  it("does not submit package source metadata while editing a connector", () => {
    const { container } = render(
      <ServerForm
        action={vi.fn().mockResolvedValue({})}
        initial={{
          sourceRef: "https://mcp.example.com/mcp",
          sourceUrl: "https://github.com/acme/mcp",
        }}
        categories={[]}
        submitLabel="Save"
        showSourceMetadata={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Fetch metadata" }),
    ).not.toBeInTheDocument();
    const data = new FormData(assertDefined(container.querySelector("form")));
    for (const name of [
      "sourceMetadataSource",
      "sourceMetadataRef",
      "sourceMetadataCanonicalUrl",
    ])
      expect(data.has(name)).toBe(false);
  });
  it("imports fetched package data and derives a valid slug without submitting the save action", async () => {
    mocks.fetchMetadata.mockResolvedValueOnce({
      metadata: {
        source: "npm",
        ref: "@acme/mcp",
        canonicalSourceUrl: "https://www.npmjs.com/package/@acme/mcp",
        name: "@Acme/MCP Server!",
        author: "Acme",
        description: "Package description",
        stars: 42,
        readme: "# Usage",
      },
    });
    const save = vi.fn().mockResolvedValue({});
    const { container } = render(
      <ServerForm
        action={save}
        initial={{}}
        categories={[]}
        submitLabel="Create"
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Package or GitHub repository" }),
      { target: { value: "@acme/mcp" } },
    );
    const fetchButton = screen.getByRole("button", { name: "Fetch metadata" });
    fireEvent(
      assertDefined(fetchButton.closest("form")),
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: fetchButton,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "@Acme/MCP Server!",
      ),
    );
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.get("slug")).toBe("acme-mcp-server");
    expect(data.get("sourceMetadataCanonicalUrl")).toBe(
      "https://www.npmjs.com/package/@acme/mcp",
    );
    expect(data.get("description")).toBe("Package description");
    expect(data.get("readme")).toBe("# Usage");
    expect(data.get("stars")).toBe("42");
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves editable values when metadata lookup fails and presents the failure", async () => {
    mocks.fetchMetadata.mockResolvedValueOnce({
      error: "Repository is private",
    });
    render(
      <ServerForm
        action={vi.fn()}
        initial={{ name: "Existing name", description: "Keep this" }}
        categories={[]}
        submitLabel="Create"
      />,
    );
    const fetchButton = screen.getByRole("button", { name: "Fetch metadata" });
    fireEvent(
      assertDefined(fetchButton.closest("form")),
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: fetchButton,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Repository is private",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Existing name",
    );
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Keep this",
    );
  });
});
