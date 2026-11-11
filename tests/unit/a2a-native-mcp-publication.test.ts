// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  runtime: vi.fn(),
  enabled: vi.fn(),
  publish: vi.fn(),
  submit: vi.fn(),
  revision: vi.fn(),
  collaborationInit: vi.fn(),
}));
vi.mock("@/lib/agents/runtime-access", () => ({
  agentRuntimeTokenFromRequest: mocks.token,
}));
vi.mock("@/lib/a2a/local-runtime", () => ({
  assertLocalRuntimeToken: mocks.runtime,
}));
vi.mock("@/lib/db", () => ({ db: { agent: { count: mocks.enabled } } }));
vi.mock("@/lib/admin/transport-settings", () => ({
  getTransportSettings: async () => ({
    allowHttp: false,
    a2aInlineBytes: 32768,
    a2aFileBytes: 10 * 1024 * 1024,
  }),
}));
vi.mock("@/lib/agents/revisions", () => ({
  requireAgentRevision: mocks.revision,
}));
vi.mock("@/lib/a2a/pi-tools", () => {
  mocks.collaborationInit();
  throw new Error("Artifact-only execution must not initialize collaboration.");
});
vi.mock("@/lib/a2a/local-policy", () => ({
  LOCAL_LIMITS: { requestBytes: 64 * 1024, tasksPerRoot: 20 },
  assertLocalGrant: vi.fn(),
  childGrant: vi.fn(),
  localTarget: vi.fn(),
}));
vi.mock("@/lib/a2a/remote-policy", () => ({
  remoteChildGrant: vi.fn(),
  remoteTarget: vi.fn(),
}));
vi.mock("@/lib/a2a/store", () => ({
  submitTask: mocks.submit,
  getTask: vi.fn(),
  requestCancellation: vi.fn(),
  retryTaskFileReception: vi.fn(),
  lockTask: vi.fn(),
  persist: vi.fn(),
}));
vi.mock("@/lib/agents/execution/worker", () => ({ wakeAgentWorker: vi.fn() }));
vi.mock("@/lib/a2a/local-artifacts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishLocalArtifact: mocks.publish,
}));
vi.mock("@/lib/a2a/files", () => ({
  listTaskFiles: vi.fn(),
  copyTaskFile: vi.fn(),
  makeTaskFilePart: vi.fn(),
  storeTaskFile: vi.fn(),
}));
vi.mock("@/lib/a2a/local-sandbox", () => ({
  storeSandboxTaskFile: vi.fn(),
  stageLocalTaskFiles: vi.fn(),
}));
vi.mock("@/lib/a2a/local-continuation", () => ({
  requestLocalInput: vi.fn(),
  requestLocalWait: vi.fn(),
}));
vi.mock("@/lib/observability/a2a-log", () => ({
  recordA2AEvent: vi.fn(),
  a2aTaskOutcome: vi.fn(),
  taskStateName: vi.fn(),
}));

import { handleRuntimeTools } from "@/lib/agents/execution/runtime-tools";

const payload = {
  a2aTaskId: "native-publication-task",
  a2aLeaseToken: "live-lease",
};
const authority = {
  row: {
    id: "native-publication-task",
    contextId: "context",
    rootTaskId: "native-publication-task",
    parentTaskId: null,
    executionBackend: "pi-sdk",
    leaseToken: "live-lease",
  },
  grant: { agentId: "agent", workspaceId: "workspace" },
  target: { targets: [] },
};
const artifact = {
  artifactId: "report",
  name: "Report",
  parts: [{ path: "/workspace/report.json", mediaType: "application/json" }],
};
async function rpc(method: string, params: unknown = {}) {
  const response = await handleRuntimeTools(
    new Request(
      "https://toolplane.test/api/v1/agent-runtime/tasks/native-publication-task/tools",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-native-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
    ),
    "native-publication-task",
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue(payload);
  mocks.runtime.mockResolvedValue(authority);
  mocks.enabled.mockResolvedValue(0);
  mocks.revision.mockResolvedValue({
    config: { a2a: { outboundEnabled: false } },
  });
  mocks.publish.mockResolvedValue({ artifactId: "report", replay: false });
});

describe("generic task runtime artifact publication dispatch", () => {
  it("publishes without outbound communication or collaboration initialization", async () => {
    const catalog = await rpc("tools/list");
    expect(
      catalog.body.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["a2a_publish_artifact"]);
    const result = await rpc("tools/call", {
      name: "a2a_publish_artifact",
      arguments: artifact,
    });
    expect(result.body.result.isError).toBe(false);
    expect(mocks.publish).toHaveBeenCalledWith(
      "native-publication-task",
      "live-lease",
      artifact,
    );
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.collaborationInit).not.toHaveBeenCalled();
  });

  it("retains pinned tool order while denying live-revoked communication", async () => {
    mocks.revision.mockResolvedValue({
      config: { a2a: { outboundEnabled: true } },
    });
    const catalog = await rpc("tools/list");
    expect(
      catalog.body.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "pi_a2a_peers",
      "pi_a2a_submit",
      "pi_a2a_status",
      "pi_a2a_cancel",
      "a2a_publish_artifact",
    ]);
    const denied = await rpc("tools/call", {
      name: "pi_a2a_peers",
      arguments: {},
    });
    expect(denied.body.result.isError).toBe(true);
    expect(mocks.submit).not.toHaveBeenCalled();
    const published = await rpc("tools/call", {
      name: "a2a_publish_artifact",
      arguments: artifact,
    });
    expect(published.body.result.isError).toBe(false);
  });

  it.each(["pi_a2a_peers", "pi_a2a_submit", "pi_a2a_status", "pi_a2a_cancel"])(
    "does not implicitly authorize %s",
    async (name) => {
      const result = await rpc("tools/call", { name, arguments: {} });
      expect(result.status).toBe(200);
      expect(result.body.result.isError).toBe(true);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid task credential before dispatch", async () => {
    mocks.token.mockResolvedValue({ ...payload, a2aTaskId: "other-task" });
    expect(
      (
        await rpc("tools/call", {
          name: "a2a_publish_artifact",
          arguments: artifact,
        })
      ).status,
    ).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects expired authority before dispatch and rechecks the lease at execution", async () => {
    mocks.runtime.mockRejectedValueOnce(new Error("Lease expired"));
    expect(
      (
        await rpc("tools/call", {
          name: "a2a_publish_artifact",
          arguments: artifact,
        })
      ).status,
    ).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
    mocks.runtime
      .mockResolvedValueOnce(authority)
      .mockRejectedValueOnce(new Error("Lease replaced after admission"));
    const raced = await rpc("tools/call", {
      name: "a2a_publish_artifact",
      arguments: artifact,
    });
    expect(raced.status).toBe(200);
    expect(raced.body.result.isError).toBe(true);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
