// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSandbox: vi.fn(),
  updateWork: vi.fn(),
  createAgentRuntimeToken: vi.fn(),
  liveStatus: vi.fn(),
  runSandboxAgentTurn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { workSession: { updateMany: mocks.updateWork } },
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  ensureAgentConversationSandbox: mocks.ensureSandbox,
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  withAgentExecutionLease: (_input: unknown, run: () => Promise<unknown>) =>
    run(),
}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: mocks.liveStatus }));
vi.mock("@/lib/agents/runtime-access", () => ({
  createAgentRuntimeToken: mocks.createAgentRuntimeToken,
  runtimeMcpProxyUrl: (id: string) => `http://toolplane.test/mcp/${id}`,
  runtimeModelProxyBase: (id: string) => `http://toolplane.test/model/${id}`,
}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({
  runSandboxAgentTurn: mocks.runSandboxAgentTurn,
}));
vi.mock("@/lib/agents/model", () => ({
  resolveModelContext: () => ({ maxTokens: 128_000, estimated: false }),
}));

import { runDedicatedSandboxTurn } from "@/lib/agents/sandbox-turn";

describe("dedicated sandbox Agent turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSandbox.mockResolvedValue({
      sandboxId: "conversation-sandbox",
      deploymentId: "conversation-deployment",
    });
    mocks.createAgentRuntimeToken.mockResolvedValue("runtime-token");
    mocks.runSandboxAgentTurn.mockResolvedValue("done");
  });

  it("skips stopped MCP deployments instead of failing the runtime startup", async () => {
    mocks.liveStatus.mockImplementation((id: string) =>
      id === "deployment-running" ? "running" : "stopped",
    );

    await runDedicatedSandboxTurn({
      agent: {
        id: "agent-1",
        workspaceId: "workspace-1",
        runtimeKind: "pi",
        disabledBuiltinTools: [],
        provider: {
          id: "provider-1",
          name: "Provider",
          format: "openai",
          baseUrl: "",
          apiKey: "",
        },
        model: "model-1",
      },
      conversationId: "conversation-1",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      deploymentIds: ["deployment-running", "deployment-stopped"],
    });

    expect(mocks.createAgentRuntimeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentIds: ["deployment-running"],
        sandboxId: "conversation-sandbox",
        conversationId: "conversation-1",
      }),
    );
    expect(mocks.runSandboxAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          {
            deploymentId: "deployment-running",
            url: "http://toolplane.test/mcp/deployment-running",
          },
        ],
      }),
    );
  });
  it("does not fall back to the template if allocation fails", async () => {
    mocks.ensureSandbox.mockRejectedValue(new Error("copy failed"));
    await expect(
      runDedicatedSandboxTurn({
        agent: {
          id: "agent-1",
          workspaceId: "workspace-1",
          runtimeKind: "pi",
          disabledBuiltinTools: [],
          provider: {
            id: "provider-1",
            name: "Provider",
            format: "openai",
            baseUrl: "",
            apiKey: "",
          },
          model: "model-1",
        },
        conversationId: "conversation-1",
        messages: [],
      }),
    ).rejects.toThrow("copy failed");
    expect(mocks.createAgentRuntimeToken).not.toHaveBeenCalled();
    expect(mocks.runSandboxAgentTurn).not.toHaveBeenCalled();
  });
});
