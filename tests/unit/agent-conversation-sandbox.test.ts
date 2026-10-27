import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  conversation: vi.fn(),
  context: vi.fn(),
  agentOwner: vi.fn(),
  revision: vi.fn(),
  snapshot: vi.fn(),
  credentials: vi.fn(),
  conversationFindMany: vi.fn(),
  contextFindMany: vi.fn(),
  stopMcp: vi.fn(),
  createVolume: vi.fn(),
  digest: vi.fn(),
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
    agent: { findFirst: mocks.agent, findUnique: mocks.agentOwner },
    agentRevision: { findFirst: mocks.revision },
    sandboxSnapshot: { findFirst: mocks.snapshot },
    agentEnvironmentCredential: { findMany: mocks.credentials },
    conversation: {
      findFirst: mocks.conversation,
      findMany: mocks.conversationFindMany,
      update: mocks.updateConversation,
    },
    a2AContext: { findFirst: mocks.context, findMany: mocks.contextFindMany },
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
vi.mock("@/lib/process/spawn-spec", () => ({
  resolveSpawnSpec: () => ({ kind: "sandbox" }),
}));
vi.mock("@/lib/process/session-mcp", () => ({ stopSessionMcp: mocks.stopMcp }));
vi.mock("@/lib/sandboxes/runtime", () => ({
  assertDockerVolumeExists: mocks.volume,
  copyDockerVolume: mocks.copy,
  createDockerVolume: mocks.createVolume,
  digestDockerVolume: mocks.digest,
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
const revision = {
  id: "revision-1",
  version: 1,
  config: {
    schemaVersion: 1,
    runtimeKind: "pi-sdk",
    systemPrompt: null,
    providerId: null,
    model: null,
    modelProviderIds: [],
    maxSteps: 20,
    disabledBuiltinTools: [],
    sandboxTemplateId: "source",
    environment: {
      kind: "docker",
      image: `native@sha256:${"a".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null as null | {
        snapshotId: string;
        volumeName: string;
        checksum: string;
      },
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [] as { name: string; credentialId: string }[],
    },
    skills: [],
    knowledgeBaseIds: [],
    packages: [],
    mcpGrants: [],
    a2a: {
      inboundEnabled: false,
      outboundEnabled: false,
      policy: { schemaVersion: 1, targets: [] },
    },
  },
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
    agentRevisionId: "revision-1",
  },
  deployment: { id: "deployment", status: "stopped" },
};
describe("durable conversation sandbox bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxAccesses.clear();
    frozenSandboxes.clear();
    mocks.liveStatus.mockReturnValue(null);
    revision.config.environment.initialSnapshot = null;
    revision.config.environment.credentialReferences = [];
    mocks.credentials.mockResolvedValue([]);
    mocks.agentOwner.mockImplementation(async ({ where }) =>
      where.id === "agent"
        ? {
            runtimeKind: "pi-sdk",
            retiredAt: null,
            workspace: { status: "active" },
          }
        : null,
    );
    mocks.revision.mockImplementation(async ({ where }) =>
      where.id === revision.id && where.agentId === "agent" ? revision : null,
    );
    mocks.conversationFindMany.mockImplementation(async ({ where }) =>
      where.sandboxId === "isolated" && where.agent.workspaceId === "workspace"
        ? [
            {
              id: "conversation",
              agentId: "agent",
              agentRevisionId: revision.id,
            },
          ]
        : [],
    );
    mocks.contextFindMany.mockImplementation(async ({ where }) =>
      where.sandboxId === "isolated" &&
      where.workspaceId === "workspace" &&
      where.targetKind === "local"
        ? [
            {
              id: "context",
              workspaceId: "workspace",
              agentId: "agent",
              agentRevisionId: revision.id,
            },
          ]
        : [],
    );
    mocks.digest.mockResolvedValue("b".repeat(64));
    mocks.snapshot.mockImplementation(async ({ where }) =>
      where.id === "frozen-snapshot" &&
      where.volumeName === "frozen-native-data" &&
      where.sandboxId === "source" &&
      where.status === "ready" &&
      where.sandbox.workspaceId === "workspace"
        ? { id: "frozen-snapshot" }
        : null,
    );
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
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
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
    expect(mocks.conversationFindMany).toHaveBeenCalledWith({
      where: { sandboxId: "isolated", agent: { workspaceId: "workspace" } },
    });
    expect(mocks.contextFindMany).toHaveBeenCalledWith({
      where: {
        sandboxId: "isolated",
        workspaceId: "workspace",
        targetKind: "local",
      },
    });
    expect(mocks.stopMcp).toHaveBeenCalledWith({
      workspaceId: "workspace",
      agentId: "agent",
      agentRevisionId: revision.id,
      conversationId: "conversation",
    });
    expect(mocks.stopMcp).toHaveBeenCalledWith({
      workspaceId: "workspace",
      agentId: "agent",
      agentRevisionId: revision.id,
      a2aContextId: "context",
    });
  });
  it("rejects archived read-only session sandboxes before starting execution", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      config: { ...sandbox.config, readOnly: true },
    });
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "Historical Agent sessions are read-only.",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
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
      { kind: "sandbox", env: {} },
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
      expect(mocks.volume).toHaveBeenCalledWith("volume-isolated");
      expect(mocks.conversation).toHaveBeenCalledWith({
        where: {
          id: "conversation",
          agentId: "agent",
          agentRevisionId: revision.id,
          legacyRevisionUnresolved: false,
          agent: { workspaceId: "workspace" },
        },
        select: { id: true },
      });
      expect(mocks.kill).not.toHaveBeenCalled();
      expect(mocks.stopContainer).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(sandboxAccesses.get("isolated")?.active).toBe(0);
  });
  it.each(["revoked", "renamed"] as const)(
    "denies a running session with an open terminal when its credential is %s",
    async (failure) => {
      revision.config.environment.credentialReferences = [
        { name: "API_TOKEN", credentialId: "credential" },
      ];
      mocks.credentials.mockResolvedValue(
        failure === "revoked"
          ? []
          : [{ id: "credential", name: "OTHER_TOKEN" }],
      );
      mocks.sandbox.mockResolvedValue({
        ...sandbox,
        deployment: { ...sandbox.deployment, status: "running" },
      });
      mocks.liveStatus.mockReturnValue("running");
      const release = beginAgentConversationSandboxAccess("isolated");
      try {
        await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
          "AGENT_CREDENTIAL_REVOKED",
        );
        expect(mocks.credentials).toHaveBeenCalledWith({
          where: {
            id: { in: ["credential"] },
            workspaceId: "workspace",
            agentId: "agent",
            revokedAt: null,
          },
          select: { id: true, name: true },
        });
        expect(sandboxAccesses.get("isolated")?.active).toBe(1);
        expect(mocks.start).not.toHaveBeenCalled();
        expect(mocks.kill).not.toHaveBeenCalled();
        expect(mocks.stopContainer).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );
  it("does not restart a bridge that stops during live reuse authorization with an open terminal", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
    });
    mocks.liveStatus.mockReturnValue("running");
    mocks.volume.mockImplementationOnce(async () => {
      expect(sandboxAccesses.get("isolated")?.active).toBe(2);
      mocks.liveStatus.mockReturnValue(null);
    });
    const release = beginAgentConversationSandboxAccess("isolated");
    try {
      await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
        "active file or terminal access",
      );
      expect(sandboxAccesses.get("isolated")?.active).toBe(1);
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
  it("does not reuse a live sandbox while a disruptive lifecycle operation holds it", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
    });
    mocks.liveStatus.mockReturnValue("running");
    frozenSandboxes.add("isolated");
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "lifecycle operation",
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("revalidates the saved volume before reusing a running sandbox", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
    });
    mocks.liveStatus.mockReturnValue("running");
    mocks.volume.mockRejectedValueOnce(new Error("missing volume"));
    const release = beginAgentConversationSandboxAccess("isolated");
    try {
      await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
        "missing volume",
      );
      expect(sandboxAccesses.get("isolated")?.active).toBe(1);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.copy).not.toHaveBeenCalled();
    } finally {
      release();
    }
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
  it("lazily creates a blank volume from the pinned environment without reading the mutable template", async () => {
    mocks.conversation.mockResolvedValue({
      id: "conversation",
      sandboxId: null,
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    });
    const result = await ensureAgentConversationSandbox(input);
    expect(mocks.createVolume).toHaveBeenCalledWith(
      `volume-${result.sandboxId}`,
    );
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.createDeployment).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceRef: revision.config.environment.image,
        installCfg: expect.objectContaining({
          image: revision.config.environment.image,
          resourceLimits: revision.config.environment.resourceLimits,
          piVersion: "0.87.1",
        }),
      }),
    });
    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          config: expect.objectContaining({ agentRevisionId: revision.id }),
        }),
      }),
    );
  });
  it("refuses unresolved historical sessions without starting their saved runtime", async () => {
    mocks.conversation.mockResolvedValue({
      id: "conversation",
      sandboxId: "isolated",
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
    });
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "read-only",
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.createVolume).not.toHaveBeenCalled();
  });
  it("rejects a running sandbox pinned to another revision even with an open terminal", async () => {
    mocks.sandbox.mockResolvedValue({
      ...sandbox,
      deployment: { ...sandbox.deployment, status: "running" },
      config: { ...sandbox.config, agentRevisionId: "other-revision" },
    });
    mocks.liveStatus.mockReturnValue("running");
    const release = beginAgentConversationSandboxAccess("isolated");
    try {
      await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
        "revision does not match",
      );
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.copy).not.toHaveBeenCalled();
      expect(sandboxAccesses.get("isolated")?.active).toBe(1);
    } finally {
      release();
    }
  });
  it("retains an immutable pin without bypassing live owner retirement", async () => {
    mocks.agentOwner.mockResolvedValue({
      runtimeKind: "pi-sdk",
      retiredAt: new Date(),
      workspace: { status: "active" },
    });
    await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
      "AGENT_EXECUTION_RETIRED",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });
  it.each(["missing", "changed"] as const)(
    "refuses a %s frozen snapshot before starting partial data",
    async (failure) => {
      revision.config.environment.initialSnapshot = {
        snapshotId: "frozen-snapshot",
        volumeName: "frozen-native-data",
        checksum: "b".repeat(64),
      };
      mocks.conversation.mockResolvedValue({
        id: "conversation",
        sandboxId: null,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      });
      if (failure === "missing") mocks.snapshot.mockResolvedValue(null);
      else mocks.digest.mockResolvedValue("c".repeat(64));
      await expect(ensureAgentConversationSandbox(input)).rejects.toThrow(
        "snapshot is unavailable or its digest changed",
      );
      expect(mocks.updateDeployment).toHaveBeenCalledWith({
        where: { id: "deployment" },
        data: { status: "copy_failed" },
      });
      expect(mocks.copy).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.updateConversation).toHaveBeenCalledWith({
        where: { id: "conversation" },
        data: { sandboxId: expect.any(String) },
      });
    },
  );
  it("atomically persists the mapping before copying a frozen snapshot and retains copy failure", async () => {
    revision.config.environment.initialSnapshot = {
      snapshotId: "frozen-snapshot",
      volumeName: "frozen-native-data",
      checksum: "b".repeat(64),
    };
    mocks.conversation.mockResolvedValue({
      id: "conversation",
      sandboxId: null,
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
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
      "frozen-native-data",
      expect.stringMatching(/^volume-/),
    );
    expect(mocks.createVolume).not.toHaveBeenCalled();
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
  it("preserves a pinned session when the mutable source template is reassigned", async () => {
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
    await expect(ensureAgentConversationSandbox(input)).resolves.toEqual({
      sandboxId: "isolated",
      deploymentId: "deployment",
    });
    expect(mocks.revision).toHaveBeenCalledWith({
      where: { id: revision.id, agentId: "agent" },
    });
    expect(mocks.updateConversation).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
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
