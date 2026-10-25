// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  directory: vi.fn(),
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
import { WorkAttachmentError } from "@/lib/attachments/work";
import { GET, POST } from "@/app/api/v1/work-sessions/route";
const base = { agentId: "agent", task: "Review project" };
const agent = {
  id: "agent",
  workspaceId: "workspace",
  runtimeKind: "pi-sdk",
  retiredAt: null,
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
  it.each(["long", "attachments"])(
    "rejects unsafe runtime command input: %s",
    async (reason) => {
      m.command.mockReturnValue({
        name: "reset",
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
  it.each(["hermes", "pi", "dsh", "retired-pi-sdk"])(
    "rejects %s history before attachments or Work admission",
    async (kind) => {
      m.agent.mockResolvedValue({
        ...agent,
        runtimeKind: kind === "retired-pi-sdk" ? "pi-sdk" : kind,
        retiredAt: kind === "retired-pi-sdk" ? new Date() : null,
      });
      const response = await POST(request());
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: "Retired Agent history is read-only.",
      });
      expect(m.attachments).not.toHaveBeenCalled();
      expect(m.create).not.toHaveBeenCalled();
      expect(m.start).not.toHaveBeenCalled();
    },
  );
  it("allows native SDK commands to be resolved by pinned package capabilities rather than a legacy command catalog", async () => {
    m.command.mockReturnValue({ name: "package-command" });
    m.commands.mockReturnValue([]);
    expect(
      (await POST(request({ ...base, task: "/package-command" }))).status,
    ).toBe(202);
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({ task: "/package-command" }),
    );
  });
  it("requires a sandbox for attachments", async () => {
    const response = await POST(request({ ...base, attachmentIds: ["file"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sandboxId is required for Work attachments",
    });
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
  it("creates SDK Work with prepared attachments and scoped runtime preferences before starting the coordinator", async () => {
    const attachments = [
      {
        id: "file",
        name: "report",
        runtimePath: "report.txt",
        mimeType: "text/plain",
      },
    ];
    m.attachments.mockResolvedValue(attachments);
    m.directory.mockReturnValue("project");
    const response = await POST(
      request({
        ...base,
        sandboxId: "sandbox",
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
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        a2aActorId: "user",
        workspaceId: "workspace",
        attachments,
        uploadedById: "user",
        reasoningEffort: "high",
        acceptanceCriteria: "All tests pass",
        workingDirectory: "project",
      }),
    );
    expect(m.start).toHaveBeenCalledWith("work");
    expect(m.kick).toHaveBeenCalledTimes(1);
  });
  it("accepts a normal pinned SDK task without attachments", async () => {
    expect((await POST(request())).status).toBe(202);
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
