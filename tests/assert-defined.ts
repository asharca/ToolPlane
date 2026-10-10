import { assert } from "vitest";

export function assertDefined<T>(value: T): NonNullable<T> {
  assert(
    value !== null && value !== undefined,
    "Expected a defined test value",
  );
  return value;
}
