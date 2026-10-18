import { describe, expect, it } from "vitest";
import {
  mcpHeaderSecrets,
  redactMcpResult,
} from "@/lib/process/mcp-result-redaction";

describe("MCP consumer result redaction", () => {
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
  it("redacts nested keys, arrays, strings and primitive exact matches without mutating results", () => {
    const value = {
      "private-token-key": [
        "private-token-suffix",
        { value: "private" },
        1234,
        true,
        null,
        false,
      ],
      safe: "visible",
    };
    expect(
      redactMcpResult(value, [
        "private",
        "private-token",
        "1234",
        "true",
        "null",
        "",
        "private-token",
      ]),
    ).toEqual({
      "[REDACTED]-key": [
        "[REDACTED]-suffix",
        { value: "[REDACTED]" },
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        false,
      ],
      safe: "visible",
    });
    expect(value["private-token-key"][0]).toBe("private-token-suffix");
  });
  it.each([
    { nested: { text: "prefix-xy-suffix" } },
    { values: [null, false, { xy: "safe" }] },
    { number: 12 },
    { boolean: true },
    { nullValue: null },
  ])("fails closed rather than exposing a short secret", (value) => {
    const secret =
      "number" in value
        ? "12"
        : "boolean" in value
          ? "true"
          : "nullValue" in value
            ? "null"
            : "xy";
    // Only 1–3-character secrets force omission; longer primitive credentials are redacted.
    if (secret.length < 4) expect(redactMcpResult(value, [secret])).toBeNull();
    else
      expect(redactMcpResult(value, [secret])).toEqual(
        "boolean" in value
          ? { boolean: "[REDACTED]" }
          : { "[REDACTED]Value": "[REDACTED]" },
      );
  });
  it("retains unrelated primitive values with absent or unmatched short secrets", () => {
    expect(
      redactMcpResult(
        { values: [null, undefined, false, 42, "safe"], object: {} },
        ["", "xy", "9999"],
      ),
    ).toEqual({ values: [null, undefined, false, 42, "safe"], object: {} });
  });
});
