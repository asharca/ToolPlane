// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  endpoint: vi.fn(),
  lockedEndpoint: vi.fn(),
  client: vi.fn(),
  run: vi.fn(),
  latest: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  raw: vi.fn(),
  transaction: vi.fn(),
  rate: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agentEndpoint: { findFirst: m.endpoint, findUnique: m.lockedEndpoint },
    agentApiClient: { findUnique: m.client },
    agentRun: {
      findFirst: m.run,
      findUnique: m.latest,
      updateMany: m.update,
      create: m.create,
    },
    $queryRaw: m.raw,
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/observability/context", () => ({
  withLogContext: (_context: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/agents/public-api/auth", () => ({
  AGENT_API_MAX_TIMEOUT_SECONDS: 600,
  hashAgentApiSubject: () => "subject",
}));
vi.mock("@/lib/agents/public-api/rate-limit", () => ({
  takeAgentApiRateLimit: m.rate,
}));
vi.mock("@/lib/agents/public-api/run-control", () => ({
  abortAgentApiRun: m.abort,
}));
import { db } from "@/lib/db";
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import {
  prepareAgentResponse as prepare,
  executePreparedAgentResponse as execute,
  getAgentResponseForPrincipal as lookup,
  requestAgentResponseCancellation as cancel,
  type PreparedAgentResponse,
} from "@/lib/agents/public-api/runs";
const principal = {
  endpointId: "endpoint",
  endpointPublicId: "public",
  clientId: "client",
  subjectHash: null,
} as AgentApiPrincipal;
const input = { principal, input: "Hello", endUser: "user", stream: false };
const scope = {
  endpointPublicId: "public",
  responseId: "response",
  clientId: "client",
  subjectHash: "subject",
};
const run = {
  id: "run",
  publicId: "response",
  requestId: "request",
  status: "completed",
  errorCode: null,
  inputCharacters: 5,
  outputCharacters: 6,
  outputText: "Answer",
  durationMs: 10,
  createdAt: new Date("2030-01-01"),
  endpoint: { publicId: "public" },
  revision: { version: 2 },
  publicConversation: { publicId: "conversation-public" },
};
const endpoint = {
  id: "endpoint",
  publicId: "public",
  workspaceId: "workspace",
  status: "active",
  currentRevision: { id: "revision", version: 2 },
  sourceAgent: { runtimeKind: "pi-sdk" },
  timeoutSeconds: 60,
  rpmLimit: 60,
  dailyRequestLimit: 1000,
  clients: [{ id: "client", rpmLimit: 30, dailyRequestLimit: 100 }],
};
beforeEach(() => {
  vi.resetAllMocks();
  m.endpoint.mockResolvedValue(endpoint);
  m.lockedEndpoint.mockResolvedValue(endpoint);
  m.client.mockResolvedValue({ endpointId: "endpoint", status: "active" });
  m.run.mockResolvedValue(run);
  m.latest.mockResolvedValue(null);
  m.update.mockResolvedValue({ count: 1 });
  m.raw.mockResolvedValue([]);
  m.transaction.mockImplementation(async (fn) => fn(db));
  m.rate.mockResolvedValue({ headers: new Headers() });
});
describe("public response capability admission", () => {
  it.each(["pi", "pi-sdk", "claude-code", "dsh"])(
    "rejects new %s work before reserving a run",
    async (runtimeKind) => {
      m.endpoint.mockResolvedValue({
        ...endpoint,
        sourceAgent: { runtimeKind },
      });
      await expect(prepare(input)).rejects.toMatchObject({
        code: "runtime_unsupported",
        status: 409,
      });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("retains credential validation", async () => {
    m.endpoint.mockResolvedValue(null);
    await expect(prepare(input)).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("replays an existing matching idempotency key without execution", async () => {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          input: "Hello",
          conversation_id: null,
          subject_hash: "subject",
          metadata: {},
        }),
      )
      .digest("hex");
    m.latest.mockResolvedValue({ ...run, requestHash });
    const prepared = await prepare({ ...input, idempotencyKey: "existing" });
    expect(prepared.replay).toBe(true);
    expect(await execute(prepared)).toMatchObject({
      id: "response",
      output_text: "Answer",
      status: "completed",
    });
    expect(m.create).not.toHaveBeenCalled();
  });
  it("does not overwrite idempotent work for a different request", async () => {
    m.latest.mockResolvedValue({ ...run, requestHash: "different" });
    await expect(
      prepare({ ...input, idempotencyKey: "existing" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("fails historical non-replay execution without emitting output", async () => {
    const onDelta = vi.fn();
    await expect(
      execute(
        {
          ...scope,
          runId: "run",
          replay: false,
        } as unknown as PreparedAgentResponse,
        { onDelta },
      ),
    ).rejects.toMatchObject({ code: "runtime_unsupported" });
    expect(onDelta).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorCode: "runtime_unsupported",
        }),
      }),
    );
  });
});
describe("retained public response history", () => {
  it("scopes lookup to endpoint, client and browser subject", async () => {
    expect(await lookup(scope)).toMatchObject({
      id: "response",
      output_text: "Answer",
    });
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicId: "response",
          clientId: "client",
          endpoint: { publicId: "public" },
          subjectHash: "subject",
        },
      }),
    );
  });
  it("conceals missing responses", async () => {
    m.run.mockResolvedValue(null);
    expect(await lookup(scope)).toBeNull();
    expect(await cancel(scope)).toBeNull();
  });
  it("still cancels an active historical run", async () => {
    m.run.mockResolvedValue({ ...run, status: "running" });
    m.latest.mockResolvedValue({ ...run, status: "cancelled" });
    expect(await cancel(scope)).toMatchObject({
      status: "cancelled",
      cancellation_requested: true,
    });
    expect(m.abort).toHaveBeenCalledWith("response");
  });
});
