import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentContent } from "@/app/docs/document-content";

describe("documentation Markdown", () => {
  it("keeps relative links on-site after sanitization and renders table and anchor targets", () => {
    const { container } = render(
      <DocumentContent
        file="docs/README.md"
        links={[
          {
            file: "docs/ARCHITECTURE.en.md",
            url: "/docs/developers/docs/ARCHITECTURE.en",
          },
        ]}
        content={
          '# Index\n\n[Architecture](./ARCHITECTURE.en.md#overview)\n\n## Overview\n\n| Name | Value |\n|---|---|\n| Runtime | Pi |\n\n<script>alert("unsafe")</script>'
        }
      />,
    );
    expect(screen.getByRole("link", { name: "Architecture" })).toHaveAttribute(
      "href",
      "/docs/developers/docs/ARCHITECTURE.en#user-content-overview",
    );
    expect(
      screen.getByRole("link", { name: "Architecture" }),
    ).not.toHaveAttribute("target");
    expect(screen.getByRole("heading", { name: "Overview" })).toHaveAttribute(
      "id",
      "user-content-overview",
    );
    expect(screen.getByRole("cell", { name: "Pi" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });
  it("resolves the same relative link separately for different source directories", () => {
    const links = [
      { file: "README.md", url: "/docs/guides/README" },
      { file: "docs/README.md", url: "/docs/guides/docs/README" },
    ];
    const first = render(
      <DocumentContent
        file="docs/ONE.md"
        links={links}
        content="[Index](./README.md)"
      />,
    );
    expect(screen.getByRole("link", { name: "Index" })).toHaveAttribute(
      "href",
      "/docs/guides/docs/README",
    );
    first.unmount();
    render(
      <DocumentContent
        file="CHANGELOG.md"
        links={links}
        content="[Index](./README.md)"
      />,
    );
    expect(screen.getByRole("link", { name: "Index" })).toHaveAttribute(
      "href",
      "/docs/guides/README",
    );
  });
});
