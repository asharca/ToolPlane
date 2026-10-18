import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  conversation: vi.fn(),
  context: vi.fn(),
  sandbox: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(),
  volume: vi.fn(),
  copy: vi.fn(),
  start: vi.fn(),
  owner: vi.fn(),
  deployment: vi.fn(),
  createDeployment: vi.fn(),
  createSandbox: vi.fn(),
  updateDeployment: vi.fn(),
  updateConversation: vi.fn(),
  pause: vi.fn(),
  sandboxFindMany: vi.fn(),
  kill: vi.fn(),
  stopContainer: vi.fn(),
  removeRuntime: vi.fn(),
  liveStatus: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const db = {
    agent: { findFirst: mocks.agent },
    conversation: {
      findFirst: mocks.conversation,
      update: mocks.updateConversation,
    },
    a2AContext: { findFirst: mocks.context },
    sandbox: {
      findFirst: mocks.sandbox,
      findMany: mocks.sandboxFindMany,
      create: mocks.createSandbox,
    },
    deployment: {
      findUniqueOrThrow: mocks.deployment,
      create: mocks.createDeployment,
      update: mocks.updateDeployment,
    },
    $queryRaw: mocks.query,
    $transaction: mocks.transaction,
  };
  mocks.transaction.mockImplementation((fn) => fn(db));
  return { db };
});
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: mocks.owner,
  beginRuntimeOperation: () => () => undefined,
  trackRuntimeOperation: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/process/supervisor", () => ({
  allowProcessRestart: vi.fn(),
  killProcess: mocks.kill,
  livePort: () => 4321,
  liveStatus: mocks.liveStatus,
  startProcess: mocks.start,
}));
vi.mock("@/lib/process/spawn-spec", () => ({ resolveSpawnSpec: () => ({}) }));
vi.mock("@/lib/sandboxes/runtime", () => ({
  assertDockerVolumeExists: mocks.volume,
  copyDockerVolume: mocks.copy,
  setDockerSandboxPaused: mocks.pause,
  stopDockerSandboxContainer: mocks.stopContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeRuntime,
  removeDockerVolumeStrict: vi.fn(),
  sandboxVolumeName: (id: string) => `volume-${id}`,
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  agentExecutionBusy: () => false,
  withAgentMaintenanceLease: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
import {
  deleteAgentConversationSandboxes,
  ensureAgentConversationSandbox,
  findAgentConversationSandbox,
  stopIdleAgentConversationSandboxes,
} from "@/lib/agents/conversation-sandbox";
import {
  beginAgentConversationSandboxAccess,
  frozenSandboxes,
  sandboxAccesses,
} from "@/lib/sandboxes/activity";
const input = {
  workspaceId: "workspace",
  agentId: "agent",
  conversationId: "conversation",
};
const sandbox = {
  id: "isolated",
  workspaceId: "workspace",
  kind: "docker",
  deploymentId: "deployment",
  config: {
    managedBy: "agent-conversation",
    agentId: "agent",
    sourceSandboxId: "source",
  },
  deployment: { id: "deployment", status: "stopped" },
};
describe("durable conversation sandbox bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxAccesses.clear();
    frozenSandboxes.clear();
    mocks.liveStatus.mockReturnValue(null);
    mocks.agent.mockResolvedValue({
      sandboxes: [
        {
          sandbox: {
            id: "source",
            workspaceId: "workspace",
            kind: "docker",
            deployment: {},
          },
        },
      ],
    });
    mocks.conversation.mockResolvedValue({
      id: "conversation",
      sandboxId: "isolated",
    });
    mocks.sandbox.mockResolvedValue(sandbox);
    mocks.deployment.mockResolvedValue(sandbox.deployment);
    mocks.volume.mockResolvedValue(undefined);
    mocks.copy.mockResolvedValue(undefined);
    mocks.createDeployment.mockResolvedValue({ id: "deployment" });
    mocks.createSandbox.mockImplementation(({ data }) => ({
      ...data,
      deployment: { id: "deployment", status: "copying" },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keeps disconnected but live PTY sessions running during idle maintenance", async () => {
    mocks.sandboxFindMany.mockResolvedValue([
      {
        ...sandbox,
        conversations: [{ id: "conversation" }],
        workSessions: [],
        a2aContexts: [],
        deployment: {
          ...sandbox.deployment,
          status: "running",
          updatedAt: new Date(0),
        },
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ active: 1 })),
    );
    await stopIdleAgentConversationSandboxes();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.stopContainer).not.toHaveBeenCalled();
  });
  it("persists stop intent before stopping an idle physical container", async () => {
    mocks.sandboxFindMany.mockResolvedValue([
      {
        ...sandbox,
        conversations: [{ id: "conversation" }],
        workSessions: [],
        a2aContexts: [],
        deployment: {
          ...sandbox.deployment,
          status: "running",
          updatedAt: new Date(0),
        },
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ active: 0 })),
    );
    await stopIdleAgentConversationSandboxes();
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: "deployment" },
      data: { status: "stopping" },
    });
    expect(mocks.stopContainer).toHaveBeenCalledWith("isolated");
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: "deployment" },
      data: { status: "stopped" },
    });
  });
  it("restarts the saved sandbox without copying native session files again", async () => {
    await expect(ensureAgentConversationSandbox(input)).resolves.toEqual({
      sandboxId: "isolated",
      deploymentId: "deployment",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.volume).toHaveBeenCalledWith("volume-isolated");
    expect(mocks.start).toHaveBeenCalledWith(
      "deployment",
      {},
      { awaitReady: true, workspaceId: "workspace" },
    );
    expect(mocks.conversation).toHaveBeenCalledWith({
      where: {
        id: "conversation",
        agentId: "agent",
        agent: { workspaceId: "workspace" },
      },
    });
  });
  it("reuses a running sandbox without disrupting an open terminal", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
    });
    mocks.liveStatus.mockReturnValue("running");
    const release = beginAgentConversationSandboxAccess("isolated");
    try {
      await expect(ensureAgentConversationSandbox(input)).resolves.toEqual({
        sandboxId: "isolated",
        deploymentId: "deployment",
      });
      expect(sandboxAccesses.get("isolated")?.active).toBe(1);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.copy).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(sandboxAccesses.get("isolated")?.active).toBe(0);
  });
  it("does not treat persisted running status as a live bridge", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
    });
    const release = beginAgentConversationSandboxAccess("isolated");
    try {
      await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
        "active file or terminal access",
      );
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
  it("atomically persists the mapping before copying and preserves it when a copy fails", async () => {
    mocks.agent.mockResolvedValue({
      sandboxes: [
        {
          sandbox: {
            id: "source",
            deploymentId: "source-deployment",
            workspaceId: "workspace",
            kind: "docker",
            config: {},
            deployment: { installCfg: { volumeName: "old-native-data" } },
          },
        },
      ],
    });
    mocks.conversation.mockResolvedValue({
      id: "conversation",
      sandboxId: null,
    });
    mocks.copy.mockImplementation(async () => {
      expect(mocks.updateConversation).toHaveBeenCalledWith({
        where: { id: "conversation" },
        data: { sandboxId: expect.any(String) },
      });
      throw new Error("copy interrupted");
    });
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "copy interrupted",
    );
    expect(mocks.query).toHaveBeenCalled();
    expect(mocks.copy).toHaveBeenCalledWith(
      "old-native-data",
      expect.stringMatching(/^volume-/),
    );
    expect(mocks.pause).toHaveBeenNthCalledWith(1, "source", true);
    expect(mocks.pause).toHaveBeenNthCalledWith(2, "source", false);
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: "deployment" },
      data: { status: "copy_failed" },
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("fails closed rather than recreating a missing saved volume", async () => {
    mocks.volume.mockRejectedValueOnce(new Error("missing volume"));
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "missing volume",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
  it("retains failed snapshot mappings without starting partial data", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "copy_failed" },
    });
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "requires recovery",
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("retains mapped deletion intent if physical cleanup cannot be confirmed", async () => {
    mocks.sandboxFindMany.mockResolvedValue([sandbox]);
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      snapshots: [],
      workSessions: [],
      a2aContexts: [],
    });
    mocks.removeRuntime.mockRejectedValueOnce(new Error("volume busy"));
    await expect(deleteAgentConversationSandboxes(input)).rejects.toThrow(
      "volume busy",
    );
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: "deployment" },
      data: { status: "deleting" },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });
  it("rejects source reassignment for execution but admits owner-only bound cleanup", async () => {
    mocks.agent.mockResolvedValue({
      sandboxes: [
        {
          sandbox: {
            id: "different-source",
            workspaceId: "workspace",
            kind: "docker",
            deployment: {},
          },
        },
      ],
    });
    await expect(findAgentConversationSandbox(input)).rejects.toThrow(
      "binding is invalid",
    );
    await expect(
      findAgentConversationSandbox({ ...input, cleanup: true }),
    ).resolves.toEqual({ sandboxId: "isolated", deploymentId: "deployment" });
    expect(mocks.owner).toHaveBeenCalled();
  });
  it("rejects mapped sandboxes owned by another Agent even for cleanup", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      config: { ...sandbox.config, agentId: "other-agent" },
    });
    await expect(
      findAgentConversationSandbox({ ...input, cleanup: true }),
    ).rejects.toThrow("binding is invalid");
  });
  it("prevents new file/terminal access while lifecycle holds the sandbox", () => {
    frozenSandboxes.add("isolated");
    expect(() => beginAgentConversationSandboxAccess("isolated")).toThrow(
      "lifecycle operation",
    );
    frozenSandboxes.delete("isolated");
    const release = beginAgentConversationSandboxAccess("isolated");
    expect(sandboxAccesses.get("isolated")?.active).toBe(1);
    release();
    release();
    expect(sandboxAccesses.get("isolated")?.active).toBe(0);
  });
});
