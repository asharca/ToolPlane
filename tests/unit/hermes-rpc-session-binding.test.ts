// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  find: vi.fn(),
  mapping: vi.fn(),
  sources: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    conversation: { updateMany: mocks.update, findFirst: mocks.find },
    agentSandbox: { findMany: mocks.sources },
  },
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: mocks.mapping,
}));
import { bindHermesRpcConversation } from "@/lib/agents/hermes-rpc-session-binding";
const input = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  conversationId: "chat-1",
  sandboxId: "sandbox-1",
  providerId: "provider-1",
  modelId: "model",
  providerFormat: "openai",
  workingDirectory: "/workspace",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.sources.mockResolvedValue([{ sandboxId: "sandbox-1" }]);
  mocks.mapping.mockResolvedValue({
    sandboxId: "sandbox-1",
    deploymentId: "deployment",
  });
});
describe("Hermes RPC conversation binding", () => {
  it("binds a conversation atomically within its workspace, agent and runtime", async () => {
    mocks.find.mockImplementation(async () => ({
      hermesRpcBinding: mocks.update.mock.calls[0][0].data.hermesRpcBinding,
    }));
    await bindHermesRpcConversation(input);
    expect(mocks.update).toHaveBeenCalledWith({
      where: {
        id: "chat-1",
        agentId: "agent-1",
        agent: { workspaceId: "ws-1", runtimeKind: "hermes-rpc" },
        publicApiConversation: { is: null },
        hermesRpcBinding: null,
      },
      data: {
        hermesRpcBinding: expect.stringMatching(/^hermes-rpc:v1:[a-f0-9]{64}$/),
      },
    });
  });
  it("rejects foreign conversations and incompatible existing bindings", async () => {
    mocks.find.mockResolvedValueOnce(null);
    await expect(bindHermesRpcConversation(input)).rejects.toThrow(/not found/);
    mocks.find.mockResolvedValueOnce({
      hermesRpcBinding: "managed-hermes-session",
    });
    await expect(bindHermesRpcConversation(input)).rejects.toThrow(/changed/);
  });
  it.each(["sandboxId", "providerId", "modelId", "workingDirectory"] as const)(
    "requires a new conversation after %s changes",
    async (field) => {
      let binding = "";
      mocks.find.mockImplementation(async () => {
        binding ||= mocks.update.mock.calls[0][0].data.hermesRpcBinding;
        return { hermesRpcBinding: binding };
      });
      await bindHermesRpcConversation(input);
      await expect(
        bindHermesRpcConversation({ ...input, [field]: "changed" }),
      ).rejects.toThrow(/changed|new conversation/);
    },
  );
  it("retains a pre-cutover binding when native state moves to an isolated sandbox", async () => {
    let originalBinding = "";
    mocks.find.mockImplementation(async () => {
      originalBinding ||= mocks.update.mock.calls[0][0].data.hermesRpcBinding;
      return { hermesRpcBinding: originalBinding };
    });
    await bindHermesRpcConversation(input);
    mocks.mapping.mockResolvedValue({
      sandboxId: "isolated",
      deploymentId: "isolated-deployment",
    });
    await expect(
      bindHermesRpcConversation({ ...input, sandboxId: "isolated" }),
    ).resolves.toBeUndefined();
    expect(mocks.update.mock.calls[1][0].data.hermesRpcBinding).toBe(
      originalBinding,
    );
  });
});
