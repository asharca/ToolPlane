// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRequest: mocks.agent }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import {
  GET,
  POST,
  DELETE,
} from "@/app/api/v1/agents/[agentId]/terminal/[[...path]]/route";
const handlers = { GET, POST, DELETE };
const context = { params: Promise.resolve({ agentId: "agent" }) };
describe.each(Object.entries(handlers))(
  "retired Agent-level terminal %s",
  (method, handler) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.user.mockResolvedValue({ id: "user" });
      mocks.agent.mockResolvedValue({ id: "agent", runtimeKind: "hermes" });
    });
    it("requires authenticated Agent access", async () => {
      mocks.user.mockResolvedValue(null);
      expect(
        (
          await handler(
            new Request("http://toolplane.test/terminal", { method }),
            context,
          )
        ).status,
      ).toBe(401);
      expect(mocks.agent).not.toHaveBeenCalled();
    });
    it("hides inaccessible Agents", async () => {
      mocks.agent.mockResolvedValue(null);
      expect(
        (
          await handler(
            new Request("http://toolplane.test/terminal", { method }),
            context,
          )
        ).status,
      ).toBe(404);
    });
    it.each(["hermes", "pi-sdk"])(
      "requires a pinned conversation instead of executing an Agent-level %s terminal",
      async (runtimeKind) => {
        mocks.agent.mockResolvedValue({ id: "agent", runtimeKind });
        const response = await handler(
          new Request("http://toolplane.test/terminal", { method }),
          context,
        );
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
          error: expect.stringContaining("pinned conversation"),
        });
        expect(mocks.agent).toHaveBeenCalledWith("agent", "user");
      },
    );
  },
);
