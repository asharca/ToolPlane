import { expect, it } from "vitest";
import { assertDefined } from "../assert-defined";

it("rejects missing test values without rejecting defined falsy values", () => {
  expect(() => assertDefined(null)).toThrow("Expected a defined test value");
  expect(() => assertDefined(undefined)).toThrow(
    "Expected a defined test value",
  );
  expect(assertDefined(false)).toBe(false);
  expect(assertDefined(0)).toBe(0);
  expect(assertDefined("")).toBe("");
});
