import { describe, expect, it } from "vitest";
import { mcpHeaderSecrets } from "@/lib/process/mcp-header-secrets";

describe("MCP header secrets", () => {
  it("extracts both complete auth headers and bare credentials", () => {
    expect(
      mcpHeaderSecrets({
        authorization: "Bearer private-token",
        basic: "bAsIc dXNlcjpwYXNz",
        custom: "custom-secret",
        empty: "",
      }),
    ).toEqual([
      "Bearer private-token",
      "private-token",
      "bAsIc dXNlcjpwYXNz",
      "dXNlcjpwYXNz",
      "custom-secret",
      "",
    ]);
  });
});
