import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { McpToolCatalog } from "@/components/dashboard/McpToolCatalog";

const labels = {
  title: "Tool catalog",
  description: "Inspect every tool.",
  count: "2 tools",
  instructions: "Instructions",
  inputSchema: "Input schema",
  schemaJson: "JSON schema",
  parameter: "Parameter",
  type: "Type",
  required: "Required",
  defaultValue: "Default",
  noDescription: "No description.",
  noArguments: "No arguments.",
};

describe("McpToolCatalog", () => {
  it("shows instructions, parameter details, and the complete input schema", async () => {
    render(
      <McpToolCatalog
        labels={labels}
        hrefForTool={(name) => `/tools/${name}`}
        tools={[
          {
            name: "search_products",
            title: "Search products",
            description: "Search the product catalog by keyword.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search term" },
                page: {
                  type: "integer",
                  description: "1-based page",
                  default: 1,
                },
              },
              required: ["query"],
            },
          },
          {
            name: "list_categories",
            description: "List all categories.",
            inputSchema: { type: "object", properties: {} },
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Search the product catalog by keyword."),
    ).toBeInTheDocument();
    expect(await screen.findByText("query")).toBeInTheDocument();
    expect(screen.getByText("Search term")).toBeInTheDocument();
    expect(screen.getByText("1-based page")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
    expect(screen.getByText("No arguments.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "search_products" }),
    ).toHaveAttribute("href", "/tools/search_products");
  });

  it("renders a lightweight linked catalog without eagerly rendering schemas", () => {
    const { container } = render(
      <McpToolCatalog
        compact
        labels={labels}
        hrefForTool={(name) => `/tools/${name}`}
        tools={[
          {
            name: "search_products",
            description: "Search the product catalog by keyword.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search term" },
              },
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("link", { name: /search_products/ }),
    ).toHaveAttribute("href", "/tools/search_products");
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Search term")).not.toBeInTheDocument();
  });
  it("explains union, enum and composition parameters without treating invalid schema values as objects", async () => {
    render(
      <McpToolCatalog
        labels={{ ...labels, descriptionColumn: "Help" }}
        tools={[
          {
            name: "complex",
            title: "complex",
            inputSchema: {
              properties: {
                union: { type: ["string", "null", 1], default: null },
                enumeration: { enum: ["one", "two"] },
                exclusive: { oneOf: [{ type: "string" }] },
                inclusive: { anyOf: [{ type: "number" }] },
                unknown: { type: [42] },
                invalid: [],
                described: { description: "Help text", default: { count: 1 } },
              },
              required: ["union", 42],
            },
          },
        ]}
      />,
    );
    expect(await screen.findByText("string | null")).toBeVisible();
    for (const type of ["enum", "oneOf", "anyOf"])
      expect(screen.getByText(type)).toBeVisible();
    expect(screen.getAllByText("any")).toHaveLength(3);
    expect(screen.getByTitle("Help text")).toBeVisible();
    expect(screen.getByText('{"count":1}')).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("truncates compact instructions but leaves full instructions available in the expanded catalog", () => {
    const description = "x".repeat(241);
    render(
      <McpToolCatalog
        compact
        labels={labels}
        tools={[
          { name: "long", title: "Long tool", description },
          { name: "empty", title: "empty", description: " " },
        ]}
      />,
    );
    expect(screen.getByText(`${"x".repeat(240)}…`)).toBeVisible();
    expect(screen.getByText("No description.")).toBeVisible();
    expect(screen.getByText("Long tool")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
