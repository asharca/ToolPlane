// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  revision: vi.fn(),
  providers: vi.fn(),
  deployments: vi.fn(),
  skills: vi.fn(),
  endpoint: vi.fn(),
  find: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  claim: vi.fn(),
  required: vi.fn(),
  runs: vi.fn(),
  bind: vi.fn(),
  mark: vi.fn(),
  records: vi.fn(),
  update: vi.fn(),
  tools: vi.fn(),
  agent: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const db = {
    $queryRaw: vi.fn(),
    agentEndpointRevision: { findFirst: m.revision },
    modelProvider: { findMany: m.providers },
    deployment: { findMany: m.deployments },
    installedSkill: { findMany: m.skills },
    agentEndpoint: { findUnique: m.endpoint },
    agentEndpointRuntime: {
      findUnique: m.find,
      count: m.count,
      create: m.create,
      updateMany: m.claim,
      findUniqueOrThrow: m.required,
    },
    agentRun: { count: m.runs, updateMany: m.bind },
    sandbox: { updateMany: m.mark },
  };
  return {
    db: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
  };
});
vi.mock("@/lib/agents/mutations", () => ({
  createAgentRecords: m.records,
  updateAgent: m.update,
  setAgentTools: m.tools,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgent: m.agent }));
vi.mock("@/lib/agents/hermes/runtime", () => ({ syncHermesRuntime: m.sync }));
import { ensureAgentEndpointRuntime as ensure } from "@/lib/agents/public-api/runtime";
const input = {
  endpointId: "endpoint",
  revisionId: "revision",
  subjectHash: "hash",
};
const allocation = {
  id: "Allocation_1",
  runtimeAgentId: "hidden",
  status: "provisioning",
  updatedAt: new Date(0),
};
const revision = {
  id: "revision",
  endpointId: "endpoint",
  runtimeImage: `nousresearch/hermes-agent@sha256:${"a".repeat(64)}`,
  systemPrompt: "immutable prompt",
  maxSteps: 10,
  providerIds: [" provider ", "provider"],
  deploymentIds: ["deployment"],
  installedSkillIds: ["skill"],
  endpoint: {
    workspaceId: "workspace",
    sourceAgent: { runtime: { kind: "hermes" } },
  },
};
const agent = {
  id: "hidden",
  publicRuntimeAllocation: { revisionId: "revision" },
  runtime: {
    kind: "hermes",
    sandbox: { config: { managedBy: "agent-endpoint-runtime" } },
  },
  modelProviders: [{ provider: { id: "provider" } }],
  servers: [{ deploymentId: "deployment" }],
  skills: [{ installedSkill: { id: "skill" } }],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  m.revision.mockResolvedValue(revision);
  m.providers.mockResolvedValue([{ id: "provider" }]);
  m.deployments.mockResolvedValue([{ id: "deployment" }]);
  m.skills.mockResolvedValue([{ id: "skill" }]);
  m.endpoint.mockResolvedValue({
    workspaceId: "workspace",
    status: "active",
    maxRuntimes: 10,
  });
  m.find.mockResolvedValue(null);
  m.count.mockResolvedValue(0);
  m.create.mockResolvedValue(allocation);
  m.claim.mockResolvedValue({ count: 1 });
  m.required.mockResolvedValue({ ...allocation, status: "ready" });
  m.runs.mockResolvedValue(1);
  m.bind.mockResolvedValue({ count: 1 });
  m.mark.mockResolvedValue({ count: 1 });
  m.records.mockResolvedValue({ id: "hidden" });
  m.agent.mockResolvedValue(agent);
  m.sync.mockResolvedValue({ status: "running" });
});
describe("public runtime immutable graph and reservations", () => {
  it.each(["", " ", "hash!", "x".repeat(257)])(
    "rejects invalid subject before provisioning %j",
    async (subjectHash) => {
      await expect(ensure({ ...input, subjectHash })).rejects.toMatchObject({
        code: "invalid_revision",
      });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("honors pre-aborted requests without allocating", async () => {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(ensure({ ...input, signal })).rejects.toThrow("cancelled");
    expect(m.revision).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "native",
    "floating-image",
    "provider",
    "no-provider",
    "deployment",
    "skill",
  ])("refuses unsafe revision resources: %s", async (reason) => {
    if (reason === "missing") m.revision.mockResolvedValue(null);
    if (reason === "native")
      m.revision.mockResolvedValue({
        ...revision,
        endpoint: { ...revision.endpoint, sourceAgent: { runtime: null } },
      });
    if (reason === "floating-image")
      m.revision.mockResolvedValue({
        ...revision,
        runtimeImage: "nousresearch/hermes-agent:latest",
      });
    if (reason === "provider") m.providers.mockResolvedValue([]);
    if (reason === "no-provider")
      m.revision.mockResolvedValue({ ...revision, providerIds: [] });
    if (reason === "deployment") m.deployments.mockResolvedValue([]);
    if (reason === "skill") m.skills.mockResolvedValue([]);
    await expect(ensure(input)).rejects.toMatchObject({
      code: "invalid_revision",
    });
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each(["missing", "disabled", "endpoint-quota", "workspace-quota"])(
    "enforces endpoint ownership and persistent runtime quota: %s",
    async (reason) => {
      if (reason === "missing") m.endpoint.mockResolvedValue(null);
      if (reason === "disabled")
        m.endpoint.mockResolvedValue({ status: "disabled" });
      if (reason === "endpoint-quota")
        m.count.mockResolvedValueOnce(10).mockResolvedValueOnce(0);
      if (reason === "workspace-quota")
        m.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1000);
      await expect(ensure(input)).rejects.toMatchObject({
        code:
          reason === "missing"
            ? "invalid_revision"
            : reason === "disabled"
              ? "provisioning"
              : "quota_exceeded",
      });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("projects only immutable approved resources into a clean runtime", async () => {
    const result = await ensure(input);
    expect(result.agent.id).toBe("hidden");
    expect(result.allocation.status).toBe("ready");
    expect(m.update).toHaveBeenCalledWith(
      "workspace",
      "hidden",
      expect.objectContaining({
        systemPrompt: "immutable prompt",
        providerIds: ["provider"],
        model: null,
      }),
    );
    expect(m.tools).toHaveBeenCalledWith("workspace", "hidden", {
      deploymentIds: ["deployment"],
      installedSkillIds: ["skill"],
      toolkitIds: [],
      sandboxIds: [],
      subAgentIds: [],
    });
    expect(m.deployments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace",
          publicInvocable: true,
        }),
      }),
    );
  });
  it("creates and marks a fresh hidden sandbox before materializing", async () => {
    m.create.mockResolvedValue({ ...allocation, runtimeAgentId: null });
    m.find
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ status: "provisioning", runtimeAgentId: null });
    expect((await ensure(input)).agent.id).toBe("hidden");
    expect(m.records).toHaveBeenCalledWith(
      expect.anything(),
      "workspace",
      "Public Endpoint runtime Allocation_1",
      "endpoint-runtime-allocation-1",
      { runtime: "hermes", hermesImage: revision.runtimeImage },
      "endpoint-runtime-allocation-1-runtime",
    );
    expect(m.mark).toHaveBeenCalledWith({
      where: { agentRuntime: { is: { agentId: "hidden" } } },
      data: { config: { managedBy: "agent-endpoint-runtime" } },
    });
  });
  it("reuses an agent record linked by a competing materializer", async () => {
    m.create.mockResolvedValue({ ...allocation, runtimeAgentId: null });
    m.find.mockResolvedValueOnce(null);
    m.find.mockResolvedValue({
      status: "provisioning",
      runtimeAgentId: "hidden",
    });
    await ensure(input);
    expect(m.records).not.toHaveBeenCalled();
  });
  it.each(["reservation", "mark", "link"])(
    "fails safely if hidden agent creation loses its reservation: %s",
    async (reason) => {
      m.create.mockResolvedValue({ ...allocation, runtimeAgentId: null });
      m.find.mockResolvedValueOnce(null);
      m.find.mockResolvedValue({
        status: reason === "reservation" ? "failed" : "provisioning",
        runtimeAgentId: null,
      });
      if (reason === "mark") m.mark.mockResolvedValue({ count: 0 });
      if (reason === "link")
        m.claim
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValue({ count: 1 });
      await expect(ensure(input)).rejects.toMatchObject({
        code: "materialization_failed",
      });
      expect(m.sync).not.toHaveBeenCalled();
    },
  );
  it.each(["error", "native", "setup_required"])(
    "never marks failed runtime synchronization %s ready",
    async (status) => {
      m.sync.mockResolvedValue({ status });
      await expect(ensure(input)).rejects.toMatchObject({
        code: "materialization_failed",
      });
      expect(m.claim).toHaveBeenLastCalledWith({
        where: { id: allocation.id, status: "provisioning" },
        data: expect.objectContaining({
          status: "failed",
          lastError: expect.stringContaining(status),
        }),
      });
    },
  );
  it.each([new Error("x".repeat(5000)), "backend failed", ""])(
    "bounds and preserves materialization errors for operators: %j",
    async (failure) => {
      m.update.mockRejectedValue(failure);
      await expect(ensure(input)).rejects.toMatchObject({
        code: "materialization_failed",
        message: "The isolated Agent runtime could not be prepared.",
      });
      expect(m.claim).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: {
            status: "failed",
            lastError:
              failure instanceof Error
                ? failure.message.slice(0, 4000)
                : failure ||
                  "Could not materialize the isolated Hermes runtime.",
          },
        }),
      );
    },
  );
  it.each(["projection", "post-sync", "ready-race"])(
    "refuses invalid final runtime state: %s",
    async (reason) => {
      if (reason === "projection") m.agent.mockResolvedValue(null);
      if (reason === "post-sync")
        m.agent.mockResolvedValueOnce(agent).mockResolvedValue(null);
      if (reason === "ready-race")
        m.claim
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValue({ count: 1 });
      await expect(ensure(input)).rejects.toMatchObject({
        code: "materialization_failed",
      });
    },
  );
  it("reuses a ready matching graph without mutating or restarting it", async () => {
    m.find.mockResolvedValue({ ...allocation, status: "ready" });
    const result = await ensure(input);
    expect(result.agent).toEqual(agent);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.claim).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastUsedAt: expect.any(Date) } }),
    );
  });
  it.each([
    "revision",
    "visibility",
    "provider",
    "deployment",
    "skill",
    "toolkit",
    "sandbox",
    "subagent",
    "missing-runtime",
  ])(
    "invalidates a ready allocation whose graph drifted: %s",
    async (reason) => {
      m.find.mockResolvedValue({ ...allocation, status: "ready" });
      const changed = {
        ...agent,
        ...(reason === "revision" ? { publicRuntimeAllocation: null } : {}),
        ...(reason === "visibility"
          ? { runtime: { ...agent.runtime, sandbox: { config: {} } } }
          : {}),
        ...(reason === "provider" ? { modelProviders: [] } : {}),
        ...(reason === "deployment" ? { servers: [] } : {}),
        ...(reason === "skill" ? { skills: [] } : {}),
        ...(reason === "toolkit" ? { toolkits: [{}] } : {}),
        ...(reason === "sandbox" ? { sandboxes: [{}] } : {}),
        ...(reason === "subagent" ? { subAgents: [{}] } : {}),
        ...(reason === "missing-runtime" ? { runtime: null } : {}),
      };
      m.agent.mockResolvedValue(changed);
      await expect(ensure(input)).rejects.toMatchObject({
        code: "provisioning",
      });
      expect(m.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            lastError: expect.stringContaining("no longer matches"),
          }),
        }),
      );
    },
  );
  it("reclaims a failed reservation and repairs immutable graph drift", async () => {
    m.find.mockResolvedValue({ ...allocation, status: "failed" });
    m.required
      .mockResolvedValueOnce(allocation)
      .mockResolvedValue({ ...allocation, status: "ready" });
    expect((await ensure(input)).allocation.status).toBe("ready");
    expect(m.sync).toHaveBeenCalled();
  });
  it("does not steal an actively provisioning reservation", async () => {
    m.find.mockResolvedValue(allocation);
    m.claim.mockResolvedValue({ count: 0 });
    await expect(ensure(input)).rejects.toMatchObject({ code: "provisioning" });
    expect(m.sync).not.toHaveBeenCalled();
  });
  it("bounds retries when a reservation disappears", async () => {
    m.find.mockResolvedValueOnce(allocation).mockResolvedValue(null);
    await expect(ensure(input)).rejects.toMatchObject({ code: "provisioning" });
    expect(m.find).toHaveBeenCalledTimes(4);
  });
  it.each(["maintenance", "competing", "ownership", "cancelled"])(
    "rejects runs that cannot own the persistent volume: %s",
    async (reason) => {
      m.find.mockResolvedValue(
        reason === "maintenance"
          ? { ...allocation, status: "deleting" }
          : allocation,
      );
      if (reason === "competing") m.runs.mockResolvedValue(1);
      else m.runs.mockResolvedValue(0);
      if (reason === "ownership") m.bind.mockResolvedValue({ count: 0 });
      if (reason === "cancelled") {
        m.find.mockResolvedValueOnce(null).mockResolvedValue(allocation);
        m.runs.mockResolvedValueOnce(0).mockResolvedValue(0);
      }
      await expect(ensure({ ...input, runId: "run" })).rejects.toMatchObject({
        code:
          reason === "cancelled" ? "materialization_failed" : "provisioning",
      });
      expect(m.sync).not.toHaveBeenCalled();
    },
  );
});
