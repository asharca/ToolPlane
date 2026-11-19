// @vitest-environment node
import { Task } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import {
  parseRuntimeFailure,
  taskRuntimeFailure,
} from "@/lib/agents/runtime-failure";

describe("runtime failure boundaries", () => {
  it.each(["PI_UNREGISTERED", "MCP_UNREGISTERED", "OMP_UNREGISTERED"])(
    "rejects unregistered tokens (%s)",
    (code) => {
      expect(parseRuntimeFailure(`${code}: PROVIDER_ERROR`)).toBeUndefined();
    },
  );

  it("only retains allowlisted reason details", () => {
    expect(
      parseRuntimeFailure(
        "PI_SDK_MODEL_FAILED: HTTP_429 RETRIED_2. Diagnostic",
      ),
    ).toEqual({
      code: "PI_SDK_MODEL_FAILED",
      reason: "HTTP_429 RETRIED_2",
    });
    expect(
      parseRuntimeFailure(
        "PI_MCP_TOOLS_UNAVAILABLE: MCP_UNREGISTERED private detail",
      ),
    ).toEqual({
      code: "PI_MCP_TOOLS_UNAVAILABLE",
    });
  });

  it("reads retired OMP ledger entries without admitting them as new failures", () => {
    const message = "OMP_MODEL_FAILED: TIMEOUT";
    expect(parseRuntimeFailure(message)).toBeUndefined();
    expect(
      taskRuntimeFailure(
        Task.fromJSON({
          status: {
            state: "TASK_STATE_FAILED",
            message: { parts: [{ text: message }] },
          },
        }),
      ),
    ).toEqual({ code: "OMP_MODEL_FAILED", reason: "TIMEOUT" });
  });
});
