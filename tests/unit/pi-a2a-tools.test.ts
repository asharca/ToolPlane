// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { Task } from "@a2a-js/sdk";
import type * as CollaborationPolicy from "@/lib/a2a/collaboration-policy";
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
  policy: vi.fn(),
  input: vi.fn(),
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
vi.mock("@/lib/a2a/collaboration-policy", async (original) => ({
  ...(await original<typeof CollaborationPolicy>()),
  collaborationPolicy: mocks.policy,
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
  requestLocalInput: mocks.input,
  requestLocalWait: vi.fn(),
}));
import { executePiCommunicationTool } from "@/lib/a2a/pi-tools";
import { CollaborationApprovalRequiredError } from "@/lib/a2a/collaboration-policy";
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
    grant: {
      agentId: "source",
      workspaceId: "workspace",
      agentRevisionId: "source-revision",
    },
    target: { targets: [] },
  });
  mocks.enabled.mockResolvedValue(1);
  mocks.policy.mockResolvedValue({ capabilityIds: [] });
  mocks.input.mockResolvedValue({
    accepted: true,
    instruction: "End this turn normally.",
  });
  mocks.localTarget.mockResolvedValue({
    id: "allowed",
    name: "Local reviewer",
    capabilityIds: [],
  });
  mocks.remotes.mockResolvedValue([
    { id: "external", name: "External reviewer" },
  ]);
  mocks.localGrant.mockResolvedValue({
    kind: "local",
    agentId: "allowed",
    agentRevisionId: "target-revision",
  });
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
  it("returns a waiting-user result rather than an invented task ID for policy confirmation", async () => {
    mocks.remoteGrant.mockRejectedValueOnce(
      new CollaborationApprovalRequiredError("Approved budget exceeded."),
    );
    const result = await executePiCommunicationTool(token, "pi_a2a_submit", {
      target: "remote:allowed",
      message: "hello",
      messageId: "budget-denied",
    });
    expect(result).toMatchObject({ accepted: true, approvalRequired: true });
    expect(result).not.toHaveProperty("taskId");
    expect(mocks.input).toHaveBeenCalledWith(
      "parent",
      "lease",
      expect.stringContaining("A reply cannot grant permissions"),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
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
