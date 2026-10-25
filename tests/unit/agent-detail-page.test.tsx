import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  agent: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentPageData: mocks.agent }));
vi.mock("@/lib/toolkits/queries", () => ({ listToolkits: vi.fn() }));
vi.mock("@/lib/sandboxes/queries", () => ({ listSandboxes: vi.fn() }));
vi.mock("@/lib/process/supervisor", () => ({ effectiveStatus: vi.fn() }));
vi.mock("@/lib/agents/channel-connections", () => ({
  listAgentChannelConnections: vi.fn(),
}));
vi.mock("@/lib/agents/public-api/queries", () => ({
  getAgentEndpointForManagement: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/components/dashboard/agents/AgentSettings", () => ({
  AgentSettings: () => null,
}));
vi.mock("@/components/dashboard/SettingsModal", () => ({
  SettingsModal: () => null,
}));

import AgentDetailPage from "@/app/app/[workspace]/agents/[agentId]/page";
const page = (searchParams = {}) =>
  AgentDetailPage({
    params: Promise.resolve({ workspace: "acme", agentId: "agent/1" }),
    searchParams: Promise.resolve(searchParams),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1" });
  mocks.workspace.mockResolvedValue({ id: "ws-1" });
  mocks.agent.mockResolvedValue({ id: "agent/1", name: "Research agent" });
});

describe("agent detail access and migrated conversations", () => {
  it("requires sign-in before reading workspace agents", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspaces before reading the agent", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("returns notFound for an absent agent even on old chat URLs", async () => {
    mocks.agent.mockResolvedValue(null);
    await expect(page({ c: "conversation-1" })).rejects.toThrow("notFound");
  });
  it.each([
    { task: "" },
    { task: "x".repeat(201), settings: "a2a" },
    { task: "task-1", settings: "general" },
    { task: ["task-1"], settings: "a2a" },
  ])(
    "rejects malformed or out-of-context A2A task selectors %j",
    async (searchParams) => {
      await expect(page(searchParams)).rejects.toThrow("notFound");
    },
  );
  it("preserves conversation identity and escapes special characters when redirecting old chat URLs", async () => {
    await expect(page({ c: "conversation & one" })).rejects.toThrow(
      "redirect:/app/acme/work?agent=agent%2F1&c=conversation+%26+one",
    );
  });
  it("migrates the chat tab to the agent-specific Work view", async () => {
    await expect(page({ tab: "chat" })).rejects.toThrow(
      "redirect:/app/acme/work?agent=agent%2F1",
    );
  });
});
