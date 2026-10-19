import { describe, expect, it, vi } from "vitest";
import { buildToolSet, toolKey } from "@/lib/agents/tools";
import type { ToolDeps } from "@/lib/agents/tools";

vi.mock("@/lib/db", () => ({ db: {} }));

describe("MCP tool set execution result classification", () => {
  it.each([
    null,
    {},
    { isError: true },
    { error: "denied" },
    { isError: false, error: "" },
  ])(
    "classifies response %j while tolerating unavailable logging",
    async (response) => {
      const logRequest = vi
        .fn<ToolDeps["logRequest"]>()
        .mockRejectedValue(new Error("log storage unavailable"));
      const deps: ToolDeps = {
        liveStatus: () => "running",
        listMcpTools: async () => [{ name: "!!!" }],
        mcpRpc: async () => response,
        logRequest,
        loadMcpToolPolicies: async () =>
          new Map([["deployment", { mode: "all", allowedTools: [] }]]),
      };
      const tools = await buildToolSet(["deployment"], "workspace", deps);
      const tool = tools[toolKey("deployment", "!!!")];
      expect(toolKey("deployment", "!!!")).toMatch(/__tool_/);
      expect(tool.description).toBe("!!!");
      const result = await tool.execute({ value: 1 });
      expect(result).toEqual(
        response ?? { error: "MCP deployment deployment is not reachable." },
      );
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: response ? 200 : 502,
          outcome:
            !response ||
            ("isError" in response && response.isError === true) ||
            ("error" in response && response.error)
              ? "error"
              : "success",
        }),
      );
      const payload = logRequest.mock.calls[0][0].payload;
      expect(typeof payload === "function" ? payload() : payload).toEqual({
        request: { name: "!!!", arguments: { value: 1 } },
        response: response ?? { error: "unreachable" },
      });
    },
  );
});
