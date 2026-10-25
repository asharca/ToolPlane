// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tools: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  db: { agentRuntime: { findUnique: mocks.runtime } },
}));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: mocks.tools,
  mcpRpc: mocks.rpc,
}));
import { POST, GET } from "@/app/api/v1/agent-runtimes/[runtimeId]/mcp/route";
beforeEach(() => vi.clearAllMocks());
describe("retired legacy runtime MCP endpoint", () => {
  it.each(["initialize", "ping", "tools/list", "tools/call"])(
    "rejects %s before reading tokens, resolving tools, or dispatching",
    async (method) => {
      const request = new Request("http://toolplane.test/legacy-mcp", {
        method: "POST",
        headers: { authorization: "Bearer retained-old-runtime-token" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            name: "deployment__write",
            arguments: { value: "must not execute" },
          },
        }),
      });
      expect((await POST(request)).status).toBe(410);
      expect(request.bodyUsed).toBe(false);
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.tools).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("does not expose the former GET discovery surface", async () => {
    expect(
      (await GET(new Request("http://toolplane.test/legacy-mcp"))).status,
    ).toBe(410);
  });
});
