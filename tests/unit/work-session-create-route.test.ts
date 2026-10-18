// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  directory: vi.fn(),
  selection: vi.fn(),
  attachments: vi.fn(),
  start: vi.fn(),
  kick: vi.fn(),
  command: vi.fn(),
  commands: vi.fn(),
  workspaceSandbox: vi.fn(),
}));
vi.mock("@/lib/agents/conversation-workspace", () => ({
  getConversationWorkspaceSandbox: m.workspaceSandbox,
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRequest: m.agent }));
vi.mock("@/lib/agents/mutations", () => ({
  AgentConfigurationError: class extends Error {},
}));
vi.mock("@/lib/agents/hermes/conversation-selection", () => ({
  prepareHermesConversationSelection: m.selection,
}));
vi.mock("@/lib/agents/hermes/profiles", () => ({
  HermesProfileError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/work/sessions", () => ({
  createWorkSession: m.create,
  listWorkSessions: m.list,
  normalizeWorkDirectory: m.directory,
}));
vi.mock("@/lib/work/coordinator", () => ({ kickWorkCoordinator: m.kick }));
vi.mock("@/lib/work/run-control", () => ({ startWorkOutput: m.start }));
vi.mock("@/lib/agents/runtime-commands", () => ({
  parseRuntimeCommand: m.command,
  runtimeCommands: m.commands,
}));
vi.mock("@/lib/attachments/work", () => ({
  prepareWorkAttachments: m.attachments,
  WorkAttachmentError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { AgentConfigurationError } from "@/lib/agents/mutations";
import { HermesProfileError } from "@/lib/agents/hermes/profiles";
import { WorkAttachmentError } from "@/lib/attachments/work";
import { GET, POST } from "@/app/api/v1/work-sessions/route";
const base = { agentId: "agent", task: "Review project" };
const agent = {
  id: "agent",
  workspaceId: "workspace",
  runtimeKind: "hermes",
  runtime: {
    kind: "hermes",
    sandboxId: "sandbox",
    sandbox: { workspaceId: "workspace", kind: "hermes", network: "bridge" },
  },
};
const request = (body: unknown = base) =>
  new Request("http://localhost/api/v1/work-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.workspaceSandbox.mockResolvedValue(null);
  m.user.mockResolvedValue({ id: "user" });
  m.agent.mockResolvedValue(agent);
  m.directory.mockReturnValue(".");
  m.command.mockReturnValue(null);
  m.commands.mockReturnValue([{ name: "reset" }]);
  m.attachments.mockResolvedValue([]);
  m.create.mockResolvedValue({
    id: "work",
    conversationId: "conversation",
    status: "queued",
  });
  m.list.mockResolvedValue([{ id: "work", status: "queued" }]);
  m.selection.mockResolvedValue({
    profile: "default",
    provider: null,
    model: null,
  });
});
describe("work-session creation and listing boundaries", () => {
  it("requires authentication for listing and creation", async () => {
    m.user.mockResolvedValue(null);
    expect(
      (await GET(new Request("http://localhost?agentId=agent"))).status,
    ).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect(m.agent).not.toHaveBeenCalled();
  });
  it("requires an owned agent to list work and returns its sessions", async () => {
    expect((await GET(new Request("http://localhost"))).status).toBe(400);
    m.agent.mockResolvedValueOnce(null);
    expect(
      (await GET(new Request("http://localhost?agentId=foreign"))).status,
    ).toBe(404);
    const response = await GET(
      new Request("http://localhost?agentId=%20agent%20"),
    );
    expect(await response.json()).toEqual([
      { id: "work", status: "queued", sandboxId: null, sandbox: null },
    ]);
    expect(m.agent).toHaveBeenLastCalledWith("agent", "user");
    expect(m.list).toHaveBeenCalledWith("workspace", "agent");
  });
  it("rejects malformed JSON", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost", { method: "POST", body: "{" }),
        )
      ).status,
    ).toBe(400);
  });
  it.each([
    { agentId: null },
    { agentId: " " },
    { sandboxId: 1 },
    { task: 1 },
    { task: " " },
    { task: "x".repeat(20001) },
    { references: [{}] },
    { acceptanceCriteria: 1 },
    { acceptanceCriteria: "x".repeat(20001) },
    { reasoningEffort: "bad" },
  ])("rejects invalid creation field %j", async (invalid) => {
    expect((await POST(request({ ...base, ...invalid }))).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });
  it("refuses invalid working directories and inaccessible agents before attachments", async () => {
    m.directory.mockReturnValueOnce(null);
    expect((await POST(request())).status).toBe(400);
    m.agent.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(404);
    expect(m.attachments).not.toHaveBeenCalled();
  });
  it.each(["unsupported", "long", "attachments"])(
    "rejects unsafe runtime command input: %s",
    async (reason) => {
      m.command.mockReturnValue({
        name: reason === "unsupported" ? "unknown" : "reset",
      });
      const body = {
        ...base,
        ...(reason === "long" ? { task: `/reset ${"x".repeat(2000)}` } : {}),
        ...(reason === "attachments" ? { attachmentIds: ["file"] } : {}),
      };
      expect((await POST(request(body))).status).toBe(400);
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    "runtime-kind",
    "runtime",
    "workspace",
    "sandbox-kind",
    "network",
    "sandbox-id",
    "profile",
    "provider-type",
    "model-type",
    "provider-missing",
    "model-missing",
  ])(
    "validates Hermes selection against runtime ownership: %s",
    async (reason) => {
      const body: Record<string, unknown> = {
        ...base,
        hermesProfile: "default",
      };
      if (reason === "runtime-kind")
        m.agent.mockResolvedValue({ ...agent, runtimeKind: "pi-sdk" });
      if (reason === "runtime")
        m.agent.mockResolvedValue({
          ...agent,
          runtime: { ...agent.runtime, kind: "other" },
        });
      if (["workspace", "sandbox-kind", "network"].includes(reason))
        m.agent.mockResolvedValue({
          ...agent,
          runtime: {
            ...agent.runtime,
            sandbox: {
              ...agent.runtime.sandbox,
              ...(reason === "workspace"
                ? { workspaceId: "foreign" }
                : reason === "sandbox-kind"
                  ? { kind: "other" }
                  : { network: "none" }),
            },
          },
        });
      if (reason === "sandbox-id") body.sandboxId = "foreign";
      if (reason === "profile") body.hermesProfile = 1;
      if (reason === "provider-type") body.hermesProvider = 1;
      if (reason === "model-type") body.hermesModel = {};
      if (reason === "provider-missing") body.hermesModel = "model";
      if (reason === "model-missing") body.hermesProvider = "provider";
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid Hermes profile or model",
      });
      expect(m.selection).not.toHaveBeenCalled();
    },
  );
  it("requires a sandbox for attachments", async () => {
    const response = await POST(request({ ...base, attachmentIds: ["file"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sandboxId is required for Work attachments",
    });
  });
  it.each([
    new HermesProfileError("missing profile", 404),
    new AgentConfigurationError("bad model"),
    new Error("private details"),
  ])("returns safe selection preparation failures", async (error) => {
    m.selection.mockRejectedValue(error);
    const response = await POST(request({ ...base, hermesProfile: "default" }));
    expect(response.status).toBe(
      error instanceof HermesProfileError
        ? 404
        : error instanceof AgentConfigurationError
          ? 400
          : 502,
    );
    expect(await response.json()).toEqual({
      error:
        error instanceof HermesProfileError ||
        error instanceof AgentConfigurationError
          ? error.message
          : "Could not prepare the Hermes model",
    });
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each(["copy", "create"])(
    "maps attachment failures at %s stage without starting a worker",
    async (stage) => {
      const failing = stage === "copy" ? m.attachments : m.create;
      failing
        .mockRejectedValueOnce(new WorkAttachmentError(409, "volume busy"))
        .mockRejectedValueOnce(new Error("private"));
      for (const expected of [
        { status: 409, message: "volume busy" },
        {
          status: 502,
          message:
            stage === "copy"
              ? "Could not copy attachments into the sandbox"
              : "Could not create the Work session",
        },
      ]) {
        const response = await POST(request());
        expect(response.status).toBe(expected.status);
        expect(await response.json()).toEqual({ error: expected.message });
      }
      expect(m.start).not.toHaveBeenCalled();
    },
  );
  it("rejects agents that cannot create work", async () => {
    m.create.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(400);
    expect(m.start).not.toHaveBeenCalled();
  });
  it("creates work with prepared attachments and explicit Hermes selection before starting coordinator", async () => {
    const attachments = [
      {
        id: "file",
        name: "report",
        runtimePath: "report.txt",
        mimeType: "text/plain",
      },
    ];
    m.attachments.mockResolvedValue(attachments);
    const response = await POST(
      request({
        ...base,
        sandboxId: "sandbox",
        hermesProfile: "default",
        hermesProvider: " provider ",
        hermesModel: " model ",
        reasoningEffort: "high",
        acceptanceCriteria: "All tests pass",
        workingDirectory: "project",
        attachmentIds: ["file"],
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      workSessionId: "work",
      conversationId: "conversation",
      status: "queued",
    });
    expect(m.selection).toHaveBeenCalledWith(agent, {
      profile: "default",
      provider: "provider",
      model: "model",
    });
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        a2aActorId: "user",
        workspaceId: "workspace",
        attachments,
        uploadedById: "user",
        reasoningEffort: "high",
        acceptanceCriteria: "All tests pass",
      }),
    );
    expect(m.start).toHaveBeenCalledWith("work");
    expect(m.kick).toHaveBeenCalledTimes(1);
  });
  it("accepts a normal task without profile or attachments", async () => {
    expect((await POST(request())).status).toBe(202);
    expect(m.selection).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalledWith({
      a2aActorId: "user",
      workspaceId: "workspace",
      agentId: "agent",
      sandboxId: undefined,
      task: "Review project",
      workingDirectory: ".",
    });
  });
});
