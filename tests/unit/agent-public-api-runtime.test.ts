// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPublicEndpointRuntime } from "@/lib/agents/public-api/runtime";
import { agentApiErrorFromStoredCode } from "@/lib/agents/public-api/errors";

describe("public endpoint capability boundary", () => {
  it.each(["pi", "pi-sdk", "claude-code", "dsh", "unknown", null])(
    "rejects unsupported runtime %s",
    (runtimeKind) => {
      expect(() => assertPublicEndpointRuntime(runtimeKind)).toThrow(
        "does not support public endpoint execution",
      );
      try {
        assertPublicEndpointRuntime(runtimeKind);
      } catch (error) {
        expect(error).toMatchObject({
          code: "runtime_unsupported",
          status: 409,
        });
      }
    },
  );
  it("restores the stable unsupported error from persisted responses", () => {
    expect(agentApiErrorFromStoredCode("runtime_unsupported")).toMatchObject({
      code: "runtime_unsupported",
      status: 409,
    });
  });
});
