import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  sandbox: vi.fn(),
  transaction: vi.fn(),
  maintenance: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: mocks.agent },
    sandbox: { findFirst: mocks.sandbox },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  deleteAgentConversationSandboxes: vi.fn(),
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  withAgentMaintenanceLease: mocks.maintenance,
}));
import { setAgentTools } from "@/lib/agents/mutations";
const tools = {
  deploymentIds: [],
  installedSkillIds: [],
  toolkitIds: [],
  sandboxIds: ["replacement"],
};
describe("conversation template assignment safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maintenance.mockImplementation((_agent, fn) => fn());
    mocks.agent.mockResolvedValue({
      id: "agent",
      runtimeKind: "pi-sdk",
      retiredAt: null,
      sandboxes: [{ sandboxId: "original" }],
    });
    mocks.sandbox.mockResolvedValue({ id: "saved-conversation-sandbox" });
  });
  it("forbids rebinding while durable isolated sandboxes still exist", async () => {
    await expect(setAgentTools("workspace", "agent", tools)).rejects.toThrow(
      "before changing its assigned template",
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.maintenance).toHaveBeenCalledWith(
      "agent",
      expect.any(Function),
    );
  });
  it("does not mutate assignments while a turn holds admission", async () => {
    mocks.maintenance.mockRejectedValueOnce(
      new Error("Agent execution capacity is busy"),
    );
    await expect(setAgentTools("workspace", "agent", tools)).rejects.toThrow(
      "capacity is busy",
    );
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
