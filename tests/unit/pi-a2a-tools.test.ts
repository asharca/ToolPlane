// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { Task } from "@a2a-js/sdk";
const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  enabled: vi.fn(),
  child: vi.fn(),
  localTarget: vi.fn(),
  remotes: vi.fn(),
  localGrant: vi.fn(),
  remoteGrant: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/lib/a2a/local-runtime", () => ({
  assertLocalRuntimeToken: mocks.runtime,
}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { count: mocks.enabled },
    remoteA2AAgent: { findMany: mocks.remotes },
    a2ATask: { findFirst: mocks.child },
  },
}));
vi.mock("@/lib/a2a/local-policy", () => ({
  childGrant: mocks.localGrant,
  localTarget: mocks.localTarget,
  LOCAL_LIMITS: { tasksPerRoot: 10 },
}));
vi.mock("@/lib/a2a/remote-policy", () => ({
  remoteChildGrant: mocks.remoteGrant,
  remoteTarget: vi.fn(),
}));
vi.mock("@/lib/a2a/store", () => ({
  submitTask: mocks.submit,
  getTask: mocks.get,
  requestCancellation: mocks.cancel,
}));
vi.mock("@/lib/a2a/worker", () => ({ wakeA2AWorker: vi.fn() }));
vi.mock("@/lib/a2a/local-artifacts", () => ({
  LocalArtifactInput: {},
  publishLocalArtifact: vi.fn(),
}));
vi.mock("@/lib/a2a/local-continuation", () => ({
  requestLocalInput: vi.fn(),
  requestLocalWait: vi.fn(),
}));
import { executePiCommunicationTool } from "@/lib/a2a/pi-tools";
const token = {} as AgentRuntimeTokenPayload;
const working = () =>
  Task.fromJSON({
    id: "public-child",
    contextId: "public-context",
    status: { state: "TASK_STATE_WORKING" },
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.mockResolvedValue({
    row: { id: "parent", rootTaskId: "root", leaseToken: "lease" },
    grant: { agentId: "source", workspaceId: "workspace" },
    target: { targets: [] },
  });
  mocks.enabled.mockResolvedValue(1);
  mocks.localTarget.mockResolvedValue({
    id: "allowed",
    name: "Local reviewer",
  });
  mocks.remotes.mockResolvedValue([
    { id: "external", name: "External reviewer" },
  ]);
  mocks.localGrant.mockResolvedValue({ kind: "local", agentId: "allowed" });
  mocks.child.mockResolvedValue({
    grant: { kind: "remote" },
    context: {
      remoteAgentId: "allowed",
      agentId: null,
      targetBinding: "binding",
    },
  });
  mocks.remoteGrant.mockResolvedValue({
    kind: "remote",
    targetBinding: "binding",
  });
  mocks.get.mockResolvedValue(working());
  mocks.cancel.mockResolvedValue(working());
});
describe("Pi communication trust boundary", () => {
  it.each([
    "agent:",
    "remote:",
    "agent:a:b",
    "agent:../a",
    "agent:a b",
    "https://peer",
    "other:a",
    `remote:${"a".repeat(201)}`,
  ])("rejects malformed target %s before delegation", async (target) => {
    await expect(
      executePiCommunicationTool(token, "pi_a2a_submit", {
        target,
        message: "hello",
        messageId: "invocation-1",
      }),
    ).rejects.toThrow();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects unknown methods and extra arguments", async () => {
    await expect(
      executePiCommunicationTool(token, "a2a_await_tasks", {
        taskIds: ["public-child"],
      }),
    ).rejects.toThrow("Unknown communication tool");
    await expect(
      executePiCommunicationTool(token, "pi_a2a_status", {
        target: "remote:allowed",
        taskId: "public-child",
        tenant: "other",
      }),
    ).rejects.toThrow();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("lists local peers and delegates and reads local tasks without external opt-in", async () => {
    mocks.enabled.mockResolvedValue(0);
    mocks.runtime.mockResolvedValue({
      row: { id: "parent", rootTaskId: "root", leaseToken: "lease" },
      grant: { agentId: "source", workspaceId: "workspace" },
      target: { targets: ["allowed"] },
    });
    mocks.child.mockResolvedValue({
      grant: { kind: "local" },
      context: { agentId: "allowed", remoteAgentId: null },
    });
    mocks.submit.mockResolvedValue({ snapshot: Task.toJSON(working()) });
    expect(await executePiCommunicationTool(token, "pi_a2a_peers", {})).toEqual(
      { peers: [{ target: "agent:allowed", name: "Local reviewer" }] },
    );
    expect(
      await executePiCommunicationTool(token, "pi_a2a_submit", {
        target: "agent:allowed",
        message: "Review this",
        messageId: "invocation-1",
      }),
    ).toMatchObject({ taskId: "public-child" });
    expect(
      await executePiCommunicationTool(token, "pi_a2a_status", {
        target: "agent:allowed",
        taskId: "public-child",
      }),
    ).toMatchObject({
      task: { id: "public-child", status: { state: "TASK_STATE_WORKING" } },
    });
    await expect(
      executePiCommunicationTool(token, "pi_a2a_submit", {
        target: "remote:external",
        message: "Must stay local",
        messageId: "invocation-2",
      }),
    ).rejects.toThrow("collaboration is disabled");
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["pi_a2a_status", "agent:allowed"],
    ["pi_a2a_status", "remote:other"],
    ["pi_a2a_cancel", "agent:allowed"],
    ["pi_a2a_cancel", "remote:other"],
  ])("rejects target-child mismatch for %s / %s", async (name, target) => {
    await expect(
      executePiCommunicationTool(token, name, {
        target,
        taskId: "public-child",
      }),
    ).rejects.toThrow("Child unavailable");
    expect(mocks.localGrant).not.toHaveBeenCalled();
    expect(mocks.remoteGrant).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("never reports a requested but unconfirmed cancellation as canceled", async () => {
    expect(
      await executePiCommunicationTool(token, "pi_a2a_cancel", {
        target: "remote:allowed",
        taskId: "public-child",
      }),
    ).toMatchObject({
      task: { id: "public-child", status: { state: "TASK_STATE_WORKING" } },
    });
  });
});
