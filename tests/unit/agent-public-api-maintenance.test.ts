// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  raw: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  remove: vi.fn(),
  active: vi.fn(),
  contexts: vi.fn(),
  tasks: vi.fn(),
  endpoint: vi.fn(),
  disable: vi.fn(),
  runs: vi.fn(),
  cancel: vi.fn(),
  deleteRuns: vi.fn(),
  count: vi.fn(),
  conversations: vi.fn(),
  touch: vi.fn(),
  deleteConversations: vi.fn(),
  stopped: vi.fn(),
  release: vi.fn(),
  cleanup: vi.fn(),
  stop: vi.fn(),
  deleteAgent: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const db = {
    $queryRaw: m.raw,
    agentEndpointRuntime: {
      findUnique: m.find,
      findMany: m.list,
      updateMany: m.claim,
      deleteMany: m.remove,
      count: m.count,
    },
    agentRun: {
      count: m.active,
      findMany: m.runs,
      updateMany: m.cancel,
      deleteMany: m.deleteRuns,
    },
    a2AContext: { count: m.contexts },
    a2ATask: { count: m.tasks },
    agentEndpoint: { findFirst: m.endpoint, update: m.disable },
    agentPublicConversation: { findMany: m.conversations, updateMany: m.touch },
    conversation: { deleteMany: m.deleteConversations },
    agentRuntime: { findFirst: m.stopped },
    agentApiMaintenanceLease: { deleteMany: m.release },
  };
  return {
    db: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
  };
});
vi.mock("@/lib/agents/hermes/runtime", () => ({
  cleanupHermesRuntime: m.cleanup,
  stopHermesRuntime: m.stop,
}));
vi.mock("@/lib/agents/mutations", () => ({ deleteAgent: m.deleteAgent }));
vi.mock("@/lib/agents/public-api/run-control", () => ({
  abortAgentApiRun: m.abort,
}));
import {
  cleanupAgentEndpointRuntimeIfUnused as cleanup,
  stopAgentEndpointRuntimeIfIdle as stop,
  cleanupAgentEndpointRuntimesForSource as source,
  runAgentApiIdleRuntimeMaintenance as idle,
} from "@/lib/agents/public-api/maintenance";
const now = new Date("2026-10-18T10:00:00Z");
const old = new Date(now.getTime() - 3600000);
const cutoff = new Date(now.getTime() - 900000);
function allocation(overrides: Record<string, unknown> = {}) {
  return {
    id: "allocation",
    runtimeAgentId: "hidden",
    status: "ready",
    updatedAt: old,
    lastUsedAt: old,
    operationId: null,
    operationExpiresAt: null,
    conversations: [],
    endpoint: { workspaceId: "workspace" },
    ...overrides,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  m.raw.mockResolvedValue([]);
  m.find.mockResolvedValue(allocation());
  m.list.mockResolvedValue([]);
  m.claim.mockResolvedValue({ count: 1 });
  m.remove.mockResolvedValue({ count: 1 });
  m.active.mockResolvedValue(0);
  m.contexts.mockResolvedValue(0);
  m.tasks.mockResolvedValue(0);
  m.endpoint.mockResolvedValue({ id: "endpoint" });
  m.runs.mockResolvedValue([]);
  m.count.mockResolvedValue(0);
  m.conversations.mockResolvedValue([]);
  m.deleteRuns.mockResolvedValue({ count: 2 });
  m.stopped.mockResolvedValue({ id: "runtime" });
  m.cleanup.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());
describe("unused public runtime cleanup", () => {
  it.each([
    null,
    allocation({ conversations: [{ deletingAt: null }] }),
    allocation({ status: "provisioning", updatedAt: now }),
    allocation({ status: "stopping", updatedAt: now }),
    allocation({ status: "deleting", updatedAt: now }),
    allocation({
      operationId: "owner",
      operationExpiresAt: new Date(now.getTime() + 1),
    }),
  ])("preserves live users and operation owners: %j", async (row) => {
    m.find.mockResolvedValue(row);
    expect(await cleanup("allocation")).toBe(false);
    expect(m.cleanup).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });
  it.each(["runs", "contexts", "race"])(
    "does not destroy a referenced or concurrently claimed runtime: %s",
    async (reason) => {
      if (reason === "runs") m.active.mockResolvedValue(1);
      if (reason === "contexts") m.contexts.mockResolvedValue(1);
      if (reason === "race") m.claim.mockResolvedValue({ count: 0 });
      expect(await cleanup("allocation")).toBe(false);
      expect(m.cleanup).not.toHaveBeenCalled();
    },
  );
  it.each(["ready", "failed", "provisioning", "stopping", "deleting"])(
    "reclaims stale %s runtime only after Hermes cleanup",
    async (status) => {
      m.find.mockResolvedValue(
        allocation({ status, operationId: "expired", operationExpiresAt: old }),
      );
      expect(await cleanup("allocation")).toBe(true);
      expect(m.cleanup).toHaveBeenCalledWith("workspace", "hidden", {
        timeoutMs: 60000,
      });
      expect(m.deleteAgent).toHaveBeenCalledWith("workspace", "hidden");
      expect(m.remove).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "allocation",
          operationId: expect.any(String),
          conversations: { none: { deletingAt: null } },
          a2aContexts: { none: {} },
        }),
      });
    },
  );
  it.each([
    { conversations: [] },
    { conversations: [{ deletingAt: now, conversationId: "transcript" }] },
  ])(
    "deletes orphan transcripts without creating an agent: %j",
    async ({ conversations }) => {
      m.find.mockResolvedValue(
        allocation({ runtimeAgentId: null, conversations }),
      );
      expect(await cleanup("allocation")).toBe(true);
      expect(m.cleanup).not.toHaveBeenCalled();
      if (conversations.length)
        expect(m.deleteConversations).toHaveBeenCalledWith({
          where: { id: { in: ["transcript"] } },
        });
    },
  );
  it("reports a lost deletion claim as incomplete", async () => {
    m.remove.mockResolvedValue({ count: 0 });
    expect(await cleanup("allocation")).toBe(false);
  });
  it.each([false, new Error("x".repeat(1100)), "disk unavailable", ""])(
    "persists bounded cleanup failures: %j",
    async (failure) => {
      if (failure === false) m.cleanup.mockResolvedValue(false);
      else m.cleanup.mockRejectedValue(failure);
      expect(await cleanup("allocation")).toBe(false);
      expect(m.deleteAgent).not.toHaveBeenCalled();
      expect(m.claim).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ status: "deleting" }),
        data: {
          status: "failed",
          operationId: null,
          operationExpiresAt: null,
          lastError:
            failure === false
              ? "Hermes runtime cleanup was not admitted."
              : failure === ""
                ? "Runtime cleanup failed."
                : failure instanceof Error
                  ? failure.message.slice(0, 1000)
                  : failure,
        },
      });
    },
  );
});
describe("idle runtime stopping", () => {
  it.each([
    null,
    allocation({ runtimeAgentId: null }),
    allocation({ lastUsedAt: null }),
    allocation({ lastUsedAt: cutoff }),
    allocation({ status: "failed" }),
    allocation({ status: "stopping", updatedAt: now }),
    allocation({
      operationId: "owner",
      operationExpiresAt: new Date(now.getTime() + 1000),
    }),
  ])("preserves active or ineligible runtimes: %j", async (row) => {
    m.find.mockResolvedValue(row);
    expect(await stop("allocation", cutoff)).toBe(false);
    expect(m.stop).not.toHaveBeenCalled();
  });
  it.each(["runs", "tasks", "race"])(
    "does not stop busy runtime: %s",
    async (reason) => {
      if (reason === "runs") m.active.mockResolvedValue(1);
      if (reason === "tasks") m.tasks.mockResolvedValue(1);
      if (reason === "race") m.claim.mockResolvedValue({ count: 0 });
      expect(await stop("allocation", cutoff)).toBe(false);
      expect(m.stop).not.toHaveBeenCalled();
    },
  );
  it.each(["ready", "stopping"])(
    "stops stale %s runtime while preserving allocation for lazy resume",
    async (status) => {
      m.find.mockResolvedValue(allocation({ status }));
      expect(await stop("allocation", cutoff)).toBe(true);
      expect(m.stop).toHaveBeenCalledWith("workspace", "hidden");
      expect(m.claim).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ status: "stopping" }),
        data: {
          status: "ready",
          operationId: null,
          operationExpiresAt: null,
          lastError: null,
        },
      });
      expect(m.remove).not.toHaveBeenCalled();
    },
  );
  it.each(["not-stopped", new Error("stop failed"), "transport failure"])(
    "records failure instead of pretending to have stopped: %j",
    async (failure) => {
      if (failure === "not-stopped") m.stopped.mockResolvedValue(null);
      else m.stop.mockRejectedValue(failure);
      expect(await stop("allocation", cutoff)).toBe(false);
      expect(m.claim).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            operationId: null,
            lastError:
              failure === "not-stopped"
                ? "Hermes runtime did not enter the stopped state."
                : failure instanceof Error
                  ? failure.message
                  : failure,
          }),
        }),
      );
    },
  );
});
describe("source-agent deletion drain", () => {
  it("allows unpublished source deletion without runtime work", async () => {
    m.endpoint.mockResolvedValue(null);
    expect(await source("workspace", "source")).toBe(true);
    expect(m.disable).not.toHaveBeenCalled();
  });
  it("disables publication before refusing an active A2A worker", async () => {
    m.tasks.mockResolvedValue(1);
    expect(await source("workspace", "source")).toBe(false);
    expect(m.disable).toHaveBeenCalledWith({
      where: { id: "endpoint" },
      data: { status: "disabled" },
    });
    expect(m.cleanup).not.toHaveBeenCalled();
  });
  it("cancels and aborts public runs before deleting hidden agents", async () => {
    m.runs.mockResolvedValue([{ id: "run", publicId: "public-run" }]);
    m.list.mockResolvedValueOnce([{ id: "allocation" }]).mockResolvedValue([]);
    expect(await source("workspace", "source")).toBe(true);
    expect(m.abort).toHaveBeenCalledWith("public-run");
    expect(m.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          completedAt: now,
        }),
      }),
    );
    expect(m.deleteAgent).toHaveBeenCalledWith("workspace", "hidden");
  });
  it.each([
    null,
    allocation({
      runtimeAgentId: null,
      conversations: [{ conversationId: "orphan" }],
    }),
  ])("continues after missing or orphaned allocations: %j", async (row) => {
    m.list.mockResolvedValueOnce([{ id: "allocation" }]);
    m.find.mockResolvedValue(row);
    expect(await source("workspace", "source")).toBe(true);
    if (row) expect(m.deleteConversations).toHaveBeenCalled();
  });
  it.each(["lease", "race", "deletion"])(
    "refuses incomplete drain: %s",
    async (reason) => {
      m.list.mockResolvedValue([{ id: "allocation" }]);
      if (reason === "lease")
        m.find.mockResolvedValue(
          allocation({
            operationId: "owner",
            operationExpiresAt: new Date(now.getTime() + 1000),
          }),
        );
      if (reason === "race") m.claim.mockResolvedValue({ count: 0 });
      if (reason === "deletion") m.remove.mockResolvedValue({ count: 0 });
      expect(await source("workspace", "source")).toBe(false);
    },
  );
  it.each([false, new Error("daemon unavailable"), "failure"])(
    "records source cleanup failure for retry: %j",
    async (failure) => {
      m.list.mockResolvedValue([{ id: "allocation" }]);
      if (failure === false) m.cleanup.mockResolvedValue(false);
      else m.cleanup.mockRejectedValue(failure);
      expect(await source("workspace", "source")).toBe(false);
      expect(m.claim).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            operationId: null,
          }),
        }),
      );
    },
  );
  it.each([0, 1])(
    "bounds repeated runtime discovery and returns remaining count %s",
    async (remaining) => {
      m.list.mockResolvedValue([{ id: "allocation" }]);
      m.count.mockResolvedValue(remaining);
      expect(await source("workspace", "source")).toBe(remaining === 0);
      expect(m.list).toHaveBeenCalledTimes(5);
    },
  );
});
describe("idle maintenance leases", () => {
  it("does nothing while another worker owns idle maintenance", async () => {
    expect(await idle(now)).toBe(0);
    expect(m.list).not.toHaveBeenCalled();
  });
  it("counts only stopped idle runtimes and releases its lease", async () => {
    m.raw
      .mockResolvedValueOnce([{ name: "idle-runtimes" }])
      .mockResolvedValue([]);
    m.list.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    m.find.mockResolvedValueOnce(allocation()).mockResolvedValueOnce(null);
    expect(await idle(now)).toBe(1);
    expect(m.release).toHaveBeenCalledWith({
      where: { name: "idle-runtimes", ownerId: expect.any(String) },
    });
  });
});
