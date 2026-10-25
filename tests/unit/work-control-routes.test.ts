// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  work: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  resume: vi.fn(),
  abort: vi.fn(),
  finish: vi.fn(),
  start: vi.fn(),
  kick: vi.fn(),
  active: vi.fn(),
  approval: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/work/sessions", () => ({
  getWorkSessionForUser: m.work,
  cancelWorkSession: m.cancel,
  finalizeWorkSessionCancellation: m.finalize,
  resumeWorkSession: m.resume,
}));
vi.mock("@/lib/work/run-control", () => ({
  abortWorkRun: m.abort,
  finishWorkOutput: m.finish,
  startWorkOutput: m.start,
  isWorkRunActive: m.active,
}));
vi.mock("@/lib/work/coordinator", () => ({ kickWorkCoordinator: m.kick }));
vi.mock("@/lib/db", () => ({
  db: {
    workApproval: { updateMany: m.approval },
    workSession: { updateMany: m.update },
  },
}));
import { POST as cancel } from "@/app/api/v1/work-sessions/[workSessionId]/cancel/route";
import { POST as resume } from "@/app/api/v1/work-sessions/[workSessionId]/resume/route";
import { POST as approve } from "@/app/api/v1/work-sessions/[workSessionId]/approvals/[approvalId]/route";
const context = {
  params: Promise.resolve({ workSessionId: "work", approvalId: "approval" }),
};
const request = (body: unknown = { decision: "allow" }) =>
  new Request("http://localhost/work", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "user" });
  m.work.mockResolvedValue({
    id: "work",
    workspaceId: "workspace",
    status: "waiting_approval",
    runtimeKind: "pi-sdk",
    readOnly: false,
    agentRevisionId: "revision-1",
    legacyRevisionUnresolved: false,
    approvals: [{ id: "approval" }],
  });
  m.cancel.mockResolvedValue({ ok: true, status: "cancelling" });
  m.resume.mockResolvedValue({ ok: true, status: "queued" });
  m.approval.mockResolvedValue({ count: 1 });
  m.active.mockReturnValue(true);
});
describe("work control authorization and state transitions", () => {
  it("requires a user and hides work outside their workspace", async () => {
    m.user.mockResolvedValue(null);
    for (const route of [cancel, resume, approve])
      expect((await route(request(), context)).status).toBe(401);
    expect(m.work).not.toHaveBeenCalled();
    m.user.mockResolvedValue({ id: "user" });
    m.work.mockResolvedValue(null);
    for (const route of [cancel, resume, approve])
      expect((await route(request(), context)).status).toBe(404);
    expect(m.work).toHaveBeenCalledWith("user", "work");
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.approval).not.toHaveBeenCalled();
  });
  it.each(["cancel", "resume"])(
    "reports missing and invalid %s transitions without touching output",
    async (operation) => {
      const route = operation === "cancel" ? cancel : resume;
      const mutation = operation === "cancel" ? m.cancel : m.resume;
      mutation.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const missing = await route(request(), context);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Not found" });
      mutation.mockResolvedValueOnce({
        ok: false,
        reason: "invalid_transition",
        status: "completed",
      });
      const conflict = await route(request(), context);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: `Cannot ${operation} completed work`,
      });
      expect(m.abort).not.toHaveBeenCalled();
      expect(m.start).not.toHaveBeenCalled();
    },
  );
  it("finalizes orphaned cancellation but leaves an active run to finish itself", async () => {
    m.abort.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(await (await cancel(request(), context)).json()).toEqual({
      status: "idle",
    });
    expect(m.finalize).toHaveBeenCalledWith("workspace", "work");
    expect(m.finish).toHaveBeenCalledWith("work");
    m.finalize.mockClear();
    m.finish.mockClear();
    expect(await (await cancel(request(), context)).json()).toEqual({
      status: "cancelling",
    });
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.finish).not.toHaveBeenCalled();
    m.cancel.mockResolvedValue({ ok: true, status: "idle" });
    m.abort.mockReturnValue(false);
    expect(await (await cancel(request(), context)).json()).toEqual({
      status: "idle",
    });
    expect(m.finish).toHaveBeenCalledWith("work");
    expect(m.finalize).not.toHaveBeenCalled();
  });
  it("allows cancellation of an actual active historical bound run without replaying it", async () => {
    m.work.mockResolvedValue({
      id: "work",
      workspaceId: "workspace",
      status: "running",
      runtimeKind: "hermes",
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      runtimeSnapshot: { hermesRunId: "retained-bound-run" },
    });
    m.abort.mockReturnValue(true);
    const response = await cancel(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelling" });
    expect(m.cancel).toHaveBeenCalledWith("workspace", "work");
    expect(m.abort).toHaveBeenCalledWith("work");
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.finish).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
    expect(m.kick).not.toHaveBeenCalled();
  });
  it.each(["resume", "approve"])(
    "does not replay read-only history through %s",
    async (operation) => {
      m.work.mockResolvedValue({
        id: "work",
        workspaceId: "workspace",
        status: "waiting_approval",
        readOnly: true,
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
        approvals: [{ id: "approval" }],
      });
      const response = await (operation === "resume" ? resume : approve)(
        request(),
        context,
      );
      expect(response.status).toBe(410);
      expect(m.resume).not.toHaveBeenCalled();
      expect(m.approval).not.toHaveBeenCalled();
      expect(m.update).not.toHaveBeenCalled();
      expect(m.start).not.toHaveBeenCalled();
      expect(m.kick).not.toHaveBeenCalled();
    },
  );
  it("restarts output and enqueues authorized resumed work", async () => {
    const response = await resume(request(), context);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued" });
    expect(m.resume).toHaveBeenCalledWith("workspace", "work", "user");
    expect(m.start).toHaveBeenCalledWith("work");
    expect(m.kick).toHaveBeenCalledTimes(1);
  });
  it("validates approval decisions and rejects unrelated or non-waiting approvals", async () => {
    const malformed = new Request("http://localhost", {
      method: "POST",
      body: "{",
    });
    expect((await approve(malformed, context)).status).toBe(400);
    expect((await approve(request({ decision: "yes" }), context)).status).toBe(
      400,
    );
    m.work.mockResolvedValueOnce({ approvals: [{ id: "different" }] });
    expect((await approve(request(), context)).status).toBe(404);
    m.work.mockResolvedValueOnce({
      status: "running",
      approvals: [{ id: "approval" }],
    });
    const response = await approve(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Cannot approve running work",
    });
    expect(m.approval).not.toHaveBeenCalled();
  });
  it("detects concurrent approval resolution", async () => {
    m.approval.mockResolvedValue({ count: 0 });
    const response = await approve(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Approval already resolved",
    });
    expect(m.update).not.toHaveBeenCalled();
  });
  it.each([
    ["allow", "allowed"],
    ["deny", "denied"],
  ])(
    "records %s exactly once against a pending approval",
    async (decision, status) => {
      const response = await approve(request({ decision }), context);
      expect(await response.json()).toEqual({ status });
      expect(m.approval).toHaveBeenCalledWith({
        where: {
          id: "approval",
          workSessionId: "work",
          status: "pending",
          workSession: { status: "waiting_approval" },
        },
        data: { status, resolvedById: "user", resolvedAt: expect.any(Date) },
      });
      expect(m.update).not.toHaveBeenCalled();
    },
  );
  it("marks approval work failed after a server restart so the user can resume explicitly", async () => {
    m.active.mockReturnValue(false);
    expect(await (await approve(request(), context)).json()).toEqual({
      status: "allowed",
    });
    expect(m.update).toHaveBeenCalledWith({
      where: { id: "work", status: "waiting_approval" },
      data: {
        status: "failed",
        error:
          "The server restarted while approval was pending. Review the decision, then resume the work.",
        completedAt: expect.any(Date),
      },
    });
  });
});
