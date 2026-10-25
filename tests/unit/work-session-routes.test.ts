// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  createWorkSession: vi.fn(),
  listWorkSessions: vi.fn(),
  getWorkSessionForUser: vi.fn(),
  appendWorkSessionInput: vi.fn(),
  archiveWorkSession: vi.fn(),
  findWorkSession: vi.fn(),
  livePort: vi.fn(),
  isWorkSessionTitlePending: vi.fn(),
  findConversationSandbox: vi.fn(),
  conversationWorkspace: vi.fn(),
  release: vi.fn(),
  pinned: vi.fn(),
}));

vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: mocks.findConversationSandbox,
  beginAgentConversationSandboxAccess: () => mocks.release,
}));
vi.mock("@/lib/agents/conversation-workspace", () => ({
  getConversationWorkspaceSandbox: mocks.conversationWorkspace,
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: mocks.resolveRequestUser,
}));
vi.mock("@/lib/agents/queries", () => ({
  getAgentForRequest: mocks.getAgentForRequest,
}));
vi.mock("@/lib/work/coordinator", () => ({
  kickWorkCoordinator: vi.fn(),
  isWorkSessionTitlePending: mocks.isWorkSessionTitlePending,
}));
vi.mock("@/lib/db", () => ({
  db: { workSession: { findFirst: mocks.findWorkSession } },
}));
vi.mock("@/lib/process/supervisor", () => ({
  livePort: mocks.livePort,
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/agents/revisions", () => ({ resolvePinnedAgent: mocks.pinned }));
vi.mock("@/lib/work/sessions", () => ({
  createWorkSession: mocks.createWorkSession,
  listWorkSessions: mocks.listWorkSessions,
  getWorkSessionForUser: mocks.getWorkSessionForUser,
  appendWorkSessionInput: mocks.appendWorkSessionInput,
  archiveWorkSession: mocks.archiveWorkSession,
  normalizeWorkDirectory: (value: unknown) =>
    typeof value === "string" && !value.startsWith("..") ? value || "." : null,
  workSessionWorkingDirectory: (value: unknown) =>
    (value as { workingDirectory?: string } | null)?.workingDirectory ?? ".",
}));

import { POST as createWork } from "@/app/api/v1/work-sessions/route";
import { GET as getWork } from "@/app/api/v1/work-sessions/[workSessionId]/route";
import { POST as appendWorkInput } from "@/app/api/v1/work-sessions/[workSessionId]/input/route";
import { POST as openWorkTerminal } from "@/app/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]/route";

describe("WorkSession API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: "user-1" });
    mocks.isWorkSessionTitlePending.mockReturnValue(false);
    mocks.findConversationSandbox.mockResolvedValue({
      sandboxId: "sandbox-1",
      deploymentId: "deployment-1",
    });
    mocks.conversationWorkspace.mockResolvedValue(null);
    mocks.getAgentForRequest.mockResolvedValue({
      id: "agent-1",
      workspaceId: "workspace-1",
      runtimeKind: "pi-sdk",
      retiredAt: null,
    });
    mocks.createWorkSession.mockResolvedValue({
      id: "work-1",
      conversationId: "conversation-1",
      status: "queued",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    mocks.appendWorkSessionInput.mockResolvedValue({
      ok: true,
      changed: true,
      status: "queued",
    });
    mocks.findWorkSession.mockResolvedValue({
      id: "work-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      runtimeKind: "pi-sdk",
      agentRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
      sandboxId: "sandbox-1",
      conversationId: "conversation-1",
      conversation: {
        agentRevisionId: "revision-1",
        legacyRevisionUnresolved: false,
        sandbox: {
          id: "sandbox-1",
          deploymentId: "deployment-1",
          kind: "docker",
        },
      },
      agent: { id: "agent-1", runtimeKind: "pi-sdk", retiredAt: null },
      sandbox: {
        id: "sandbox-1",
        deploymentId: "deployment-1",
        kind: "docker",
      },
    });
    mocks.livePort.mockReturnValue(4312);
    mocks.pinned.mockImplementation(async (agent) => ({
      ...agent,
      agentRevisionId: "revision-1",
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates and enqueues work with an initial task", async () => {
    const response = await createWork(
      new Request("http://toolplane.test/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "agent-1",
          sandboxId: "sandbox-1",
          task: "Run the tests",
          reasoningEffort: "high",
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      workSessionId: "work-1",
      conversationId: "conversation-1",
      status: "queued",
    });
    expect(mocks.createWorkSession).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      sandboxId: "sandbox-1",
      task: "Run the tests",
      a2aActorId: "user-1",
      reasoningEffort: "high",
      workingDirectory: ".",
    });
  });

  it("rejects an unsupported Work reasoning effort", async () => {
    const response = await createWork(
      new Request("http://toolplane.test/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "agent-1",
          task: "Run the tests",
          reasoningEffort: "ultra",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
  });

  it("validates references before either create or append and forwards valid reference context", async () => {
    const request = (body: unknown) =>
      new Request("http://toolplane.test/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const references = [
      {
        kind: "file",
        id: "plan.md",
        label: "plan.md",
        text: "Reference material: release checklist",
      },
    ];
    const params = { params: Promise.resolve({ workSessionId: "work-1" }) };
    const invalid = { references: Array(11).fill(references[0]) };
    expect(
      (
        await createWork(
          request({ agentId: "agent-1", task: "Review", ...invalid }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await appendWorkInput(request({ input: "Review", ...invalid }), params))
        .status,
    ).toBe(400);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
    expect(mocks.getWorkSessionForUser).not.toHaveBeenCalled();
    expect(
      (
        await createWork(
          request({
            agentId: "agent-1",
            sandboxId: "sandbox-1",
            task: "Review",
            references,
          }),
        )
      ).status,
    ).toBe(202);
    expect(mocks.createWorkSession).toHaveBeenCalledWith(
      expect.objectContaining({ references }),
    );
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sandbox: { id: "sandbox-1" },
    });
    expect(
      (await appendWorkInput(request({ input: "Review", references }), params))
        .status,
    ).toBe(202);
    expect(mocks.appendWorkSessionInput).toHaveBeenCalledWith(
      "workspace-1",
      "work-1",
      "Review",
      { references, a2aActorId: "user-1" },
    );
  });

  it.each(["hermes", "pi", "dsh"])(
    "does not admit new Work for retired %s execution",
    async (runtimeKind) => {
      mocks.getAgentForRequest.mockResolvedValue({
        id: "agent-1",
        workspaceId: "workspace-1",
        runtimeKind,
      });
      const response = await createWork(
        new Request("http://toolplane.test/api/v1/work-sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: "agent-1", task: "Run the tests" }),
        }),
      );
      expect(response.status).toBe(410);
      expect(mocks.createWorkSession).not.toHaveBeenCalled();
    },
  );

  it("updates a scoped Work conversation reasoning effort before requeueing", async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      runtimeSnapshot: null,
      sandbox: { id: "sandbox-1" },
    });
    const response = await appendWorkInput(
      new Request("http://toolplane.test/api/v1/work-sessions/work-1/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Continue", reasoningEffort: "low" }),
      }),
      { params: Promise.resolve({ workSessionId: "work-1" }) },
    );

    expect(response.status).toBe(202);
    expect(mocks.getWorkSessionForUser).toHaveBeenCalledWith(
      "user-1",
      "work-1",
    );
    expect(mocks.appendWorkSessionInput).toHaveBeenCalledWith(
      "workspace-1",
      "work-1",
      "Continue",
      { reasoningEffort: "low", a2aActorId: "user-1" },
    );
  });

  it("rejects an unsupported effort before loading a Work session", async () => {
    const response = await appendWorkInput(
      new Request("http://toolplane.test/api/v1/work-sessions/work-1/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Continue", reasoningEffort: "ultra" }),
      }),
      { params: Promise.resolve({ workSessionId: "work-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.getWorkSessionForUser).not.toHaveBeenCalled();
  });

  it("rejects a working directory outside the sandbox root", async () => {
    const response = await createWork(
      new Request("http://toolplane.test/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "agent-1",
          task: "Run the tests",
          workingDirectory: "../private",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createWorkSession).not.toHaveBeenCalled();
  });

  it("requires a non-empty task", async () => {
    const response = await createWork(
      new Request("http://toolplane.test/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", task: "   " }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
  });

  it("reads a session only through the caller workspace boundary", async () => {
    mocks.isWorkSessionTitlePending.mockReturnValue(true);
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      status: "queued",
      conversation: { messages: [] },
      sandbox: null,
    });
    const response = await getWork(
      new Request("http://toolplane.test/api/v1/work-sessions/work-1"),
      { params: Promise.resolve({ workSessionId: "work-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      titlePending: true,
    });
    expect(mocks.getWorkSessionForUser).toHaveBeenCalledWith(
      "user-1",
      "work-1",
    );
  });

  it("opens the selected Work sandbox terminal session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"id":"terminal-1"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await openWorkTerminal(
      new Request("http://toolplane.test/sandbox/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      {
        params: Promise.resolve({
          workSessionId: "work-1",
          path: ["terminal"],
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4312/terminal/session",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
  it("rejects a Work sandbox that differs from the exact conversation mapping", async () => {
    mocks.findConversationSandbox.mockResolvedValue({
      sandboxId: "another-conversation",
      deploymentId: "deployment-1",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await openWorkTerminal(
      new Request("http://localhost/terminal", { method: "POST" }),
      {
        params: Promise.resolve({
          workSessionId: "work-1",
          path: ["terminal"],
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.findConversationSandbox).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
  });

  it("does not expose template files before the first Work execution", async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      runtimeKind: "pi-sdk",
      readOnly: false,
      conversation: { messages: [] },
      sandbox: {
        id: "template",
        deploymentId: "template-deployment",
        deployment: { status: "running" },
      },
    });
    const response = await getWork(new Request("http://localhost/work"), {
      params: Promise.resolve({ workSessionId: "work-1" }),
    });
    expect((await response.json()).sandbox).toBeNull();
  });

  it.each([
    { runtimeKind: "hermes" },
    { legacyRevisionUnresolved: true, agentRevisionId: null },
    {
      conversation: {
        agentRevisionId: "another-revision",
        legacyRevisionUnresolved: false,
        sandbox: null,
      },
    },
  ])(
    "denies terminal mutation for retained or unresolved Work %# without starting a runtime",
    async (override) => {
      const row = await mocks.findWorkSession();
      mocks.findWorkSession.mockResolvedValue({ ...row, ...override });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const response = await openWorkTerminal(
        new Request("http://toolplane.test/sandbox/terminal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        {
          params: Promise.resolve({
            workSessionId: "work-1",
            path: ["terminal"],
          }),
        },
      );
      expect(response.status).toBe(410);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.pinned).not.toHaveBeenCalled();
      expect(mocks.findConversationSandbox).not.toHaveBeenCalled();
    },
  );

  it("rejects revoked pinned authorization before opening the bound sandbox", async () => {
    mocks.pinned.mockRejectedValue(new Error("AGENT_GRANT_REVOKED"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await openWorkTerminal(
      new Request("http://toolplane.test/sandbox/terminal", { method: "POST" }),
      {
        params: Promise.resolve({
          workSessionId: "work-1",
          path: ["terminal"],
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.findConversationSandbox).not.toHaveBeenCalled();
  });

  it("denies new input and attachment staging for read-only history", async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      runtimeKind: "pi-sdk",
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      conversationId: "conversation-1",
      sandbox: { id: "sandbox-1" },
    });
    const response = await appendWorkInput(
      new Request("http://toolplane.test/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Continue", attachmentIds: ["file"] }),
      }),
      { params: Promise.resolve({ workSessionId: "work-1" }) },
    );
    expect(response.status).toBe(410);
    expect(mocks.appendWorkSessionInput).not.toHaveBeenCalled();
  });

  it("retains recorded historical sandbox metadata without using the Agent template", async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: "work-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      runtimeKind: "hermes",
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      conversation: { messages: [] },
      sandbox: {
        id: "historical",
        name: "Retained files",
        kind: "hermes",
        deploymentId: "historical-deployment",
        deployment: { status: "stopped" },
      },
    });
    const response = await getWork(new Request("http://toolplane.test/work"), {
      params: Promise.resolve({ workSessionId: "work-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      sandbox: {
        id: "historical",
        deploymentId: "historical-deployment",
        status: "stopped",
        running: false,
      },
    });
  });
});
