// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRequest: mocks.agent }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { GET as models } from "@/app/api/v1/agents/[agentId]/hermes/models/route";
import { GET as profiles } from "@/app/api/v1/agents/[agentId]/hermes/profiles/route";
const handlers = { models, profiles };
const context = { params: Promise.resolve({ agentId: "agent" }) };
describe.each(Object.entries(handlers))(
  "retired Hermes %s API",
  (_name, handler) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.user.mockResolvedValue({ id: "user" });
      mocks.agent.mockResolvedValue({ id: "agent", runtimeKind: "hermes" });
    });
    it("requires authentication", async () => {
      mocks.user.mockResolvedValue(null);
      expect(
        (await handler(new Request("http://toolplane.test/hermes"), context))
          .status,
      ).toBe(401);
      expect(mocks.agent).not.toHaveBeenCalled();
    });
    it("does not expose an inaccessible Agent", async () => {
      mocks.agent.mockResolvedValue(null);
      expect(
        (await handler(new Request("http://toolplane.test/hermes"), context))
          .status,
      ).toBe(404);
    });
    it("returns retirement without runtime projection, model rebinding, or boot", async () => {
      expect(
        (await handler(new Request("http://toolplane.test/hermes"), context))
          .status,
      ).toBe(410);
      expect(mocks.agent).toHaveBeenCalledWith("agent", "user");
    });
  },
);
