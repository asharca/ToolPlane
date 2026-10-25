// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRequest: mocks.agent }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { POST } from "@/app/api/v1/agents/[agentId]/attachments/route";
const context = { params: Promise.resolve({ agentId: "agent-1" }) };
describe("retired Agent-level attachment uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "user-1" });
    mocks.agent.mockResolvedValue({ id: "agent-1", runtimeKind: "hermes" });
  });
  it("requires authentication before exposing historical Agent access", async () => {
    mocks.user.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request("http://toolplane.test/attachments", { method: "POST" }),
          context,
        )
      ).status,
    ).toBe(401);
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("does not expose an inaccessible Agent", async () => {
    mocks.agent.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request("http://toolplane.test/attachments", { method: "POST" }),
          context,
        )
      ).status,
    ).toBe(404);
  });
  it.each(["hermes", "hermes-rpc", "pi", "pi-sdk"])(
    "does not upload bytes or allocate legacy storage for %s",
    async (runtimeKind) => {
      mocks.agent.mockResolvedValue({ id: "agent-1", runtimeKind });
      const request = new Request("http://toolplane.test/attachments", {
        method: "POST",
        body: "private file contents",
      });
      const response = await POST(request, context);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: expect.stringContaining("pinned Pi conversation"),
      });
      expect(request.bodyUsed).toBe(false);
      expect(mocks.agent).toHaveBeenCalledWith("agent-1", "user-1");
    },
  );
});
