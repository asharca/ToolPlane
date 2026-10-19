// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  endpoint: vi.fn(),
  lockedEndpoint: vi.fn(),
  client: vi.fn(),
  run: vi.fn(),
  latest: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
  taskCount: vi.fn(),
  conversation: vi.fn(),
  conversationCount: vi.fn(),
  raw: vi.fn(),
  transaction: vi.fn(),
  native: vi.fn(),
  rate: vi.fn(),
  allocate: vi.fn(),
  abort: vi.fn(),
  unregister: vi.fn(),
  executionAgent: vi.fn(),
  lease: vi.fn(),
  stream: vi.fn(),
  messages: vi.fn(),
  aggregate: vi.fn(),
  saveMessages: vi.fn(),
  release: vi.fn(),
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
      count: m.count,
    },
    a2ATask: { count: m.taskCount },
    message: {
      findMany: m.messages,
      aggregate: m.aggregate,
      createMany: m.saveMessages,
    },
    conversation: { updateMany: m.update },
    agentEndpointRuntime: { updateMany: m.update },
    agentPublicConversation: {
      findFirst: m.conversation,
      count: m.conversationCount,
      updateMany: m.update,
    },
    $queryRaw: m.raw,
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/a2a/quotas", () => ({ readNativeQuotaCharges: m.native }));
vi.mock("@/lib/observability/events", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/observability/context", () => ({
  enrichLogContext: vi.fn(),
  withLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/agents/queries", () => ({
  getAgentEndpointRuntimeForExecution: m.executionAgent,
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  acquireHermesRuntimeWriteLease: m.lease,
}));
vi.mock("@/lib/agents/hermes/client", () => ({
  HermesResponseTooLargeError: class extends Error {},
  runHermesTextStream: m.stream,
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
  registerAgentApiRun: () => m.unregister,
}));
vi.mock("@/lib/agents/public-api/runtime", () => ({
  ensureAgentEndpointRuntime: m.allocate,
  AgentEndpointRuntimeAllocationError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { db } from "@/lib/db";
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import { AgentEndpointRuntimeAllocationError } from "@/lib/agents/public-api/runtime";
import { HermesResponseTooLargeError } from "@/lib/agents/hermes/client";
import type { PreparedAgentResponse } from "@/lib/agents/public-api/runs";
import {
  agentRunResponseView,
  getAgentResponseForPrincipal as lookup,
  requestAgentResponseCancellation as cancel,
  prepareAgentResponse as prepare,
  executePreparedAgentResponse as execute,
} from "@/lib/agents/public-api/runs";
const principal: AgentApiPrincipal = {
  credentialType: "api_key",
  endpointId: "endpoint",
  endpointPublicId: "public",
  workspaceId: "workspace",
  sourceAgentId: "source",
  revisionId: "revision",
  clientId: "client",
  keyId: "key",
  subjectHash: null,
  origin: null,
  scopes: [],
  limits: {
    rpm: 60,
    dailyRequests: 1000,
    maxConcurrent: 2,
    timeoutSeconds: 60,
    retentionDays: 30,
  },
  rateBuckets: {
    endpointRpm: 60,
    clientRpm: 60,
    endpointDaily: 1000,
    clientDaily: 1000,
  },
};
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
  status: "running",
  errorCode: null,
  inputCharacters: 5,
  outputCharacters: 0,
  durationMs: null,
  outputText: null,
  createdAt: new Date("2030-01-01T00:00:00Z"),
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
  isolationMode: "subject",
  timeoutSeconds: 60,
  maxConcurrent: 10,
  rpmLimit: 60,
  dailyRequestLimit: 1000,
  dailyOutputCharacterLimit: 1000000000,
  maxStoredCharacters: 1000000000,
  clients: [{ id: "client", rpmLimit: 30, dailyRequestLimit: 100 }],
};
const zeroBudget = {
  endpointOutput: 0,
  clientOutput: 0,
  workspaceOutput: 0,
  endpointStored: 0,
  clientStored: 0,
  workspaceStored: 0,
  endpointActive: 0,
  clientActive: 0,
  workspaceActive: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.endpoint.mockResolvedValue(endpoint);
  m.lockedEndpoint.mockResolvedValue(endpoint);
  m.client.mockResolvedValue({
    endpointId: "endpoint",
    status: "active",
    maxConcurrent: 10,
    dailyOutputCharacterLimit: 1000000000,
    maxStoredCharacters: 1000000000,
  });
  m.run.mockResolvedValue(run);
  m.latest.mockResolvedValue(null);
  m.update.mockResolvedValue({ count: 1 });
  m.create.mockImplementation(async ({ data }) => ({ id: "run", ...data }));
  m.count.mockResolvedValue(0);
  m.taskCount.mockResolvedValue(0);
  m.conversationCount.mockResolvedValue(0);
  m.conversation.mockResolvedValue(null);
  m.raw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join("").includes('AS "endpointOutput"') ? [zeroBudget] : [],
  );
  m.transaction.mockImplementation(async (callback) => callback(db));
  m.native.mockResolvedValue({});
  m.rate.mockResolvedValue({
    headers: new Headers({ "ratelimit-limit": "60" }),
  });
  m.allocate.mockRejectedValue(new Error("runtime offline"));
});
describe("public response lookup and cancellation", () => {
  it("scopes responses by endpoint, client and subject and conceals missing runs", async () => {
    m.run.mockResolvedValueOnce(null);
    expect(await lookup(scope)).toBeNull();
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
    const result = await lookup({ ...scope, subjectHash: null });
    expect(result).toMatchObject({
      id: "response",
      status: "running",
      output: [],
      output_text: "",
      conversation_id: "conversation-public",
      usage: { input_characters: 5, output_characters: 0, duration_ms: 0 },
    });
    expect(m.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          publicId: "response",
          clientId: "client",
          endpoint: { publicId: "public" },
        },
      }),
    );
  });
  it("exposes completed assistant content and sanitized public errors", () => {
    const response = agentRunResponseView({
      ...run,
      status: "failed",
      errorCode: "request_timeout",
      outputText: "Partial",
      outputCharacters: 7,
      durationMs: 123,
      publicConversation: null,
    });
    expect(response).toMatchObject({
      conversation_id: null,
      output_text: "Partial",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Partial" }],
        },
      ],
      error: { code: "request_timeout", message: expect.any(String) },
      usage: { input_characters: 5, output_characters: 7, duration_ms: 123 },
    });
  });
  it("hides missing cancellation targets and does not cancel terminal runs", async () => {
    m.run
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...run, status: "completed" });
    expect(await cancel(scope)).toBeNull();
    expect(await cancel(scope)).toMatchObject({
      status: "completed",
      cancellation_requested: false,
    });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.abort).not.toHaveBeenCalled();
  });
  it.each(["provisioning", "running"])(
    "cancels %s runs atomically and aborts their worker",
    async (status) => {
      m.run.mockResolvedValue({ ...run, status });
      m.latest.mockResolvedValue({
        ...run,
        status: "cancelled",
        errorCode: "cancelled",
      });
      expect(await cancel(scope)).toMatchObject({
        status: "cancelled",
        cancellation_requested: true,
        error: { code: "cancelled" },
      });
      expect(m.update).toHaveBeenCalledWith({
        where: {
          id: "run",
          status: { in: ["provisioning", "running"] },
          cancelRequestedAt: null,
        },
        data: {
          status: "cancelled",
          errorCode: "cancelled",
          cancelRequestedAt: expect.any(Date),
          completedAt: expect.any(Date),
        },
      });
      expect(m.abort).toHaveBeenCalledWith("response");
    },
  );
  it("does not abort a run when concurrent completion wins cancellation", async () => {
    m.update.mockResolvedValue({ count: 0 });
    expect(await cancel(scope)).toMatchObject({
      status: "running",
      cancellation_requested: false,
    });
    expect(m.abort).not.toHaveBeenCalled();
  });
});
describe("public run admission boundaries", () => {
  it("rejects mismatched browser subjects and malformed idempotency keys before database access", async () => {
    await expect(
      prepare({
        ...input,
        principal: { ...principal, subjectHash: "different" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    for (const idempotencyKey of ["x".repeat(129), "line\nbreak", "delete\x7f"])
      await expect(prepare({ ...input, idempotencyKey })).rejects.toMatchObject(
        { code: "invalid_request", status: 400 },
      );
    expect(m.endpoint).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...endpoint, currentRevision: null },
    { ...endpoint, clients: [] },
  ])(
    "requires a live endpoint revision and active client: %j",
    async (value) => {
      m.endpoint.mockResolvedValue(value);
      await expect(prepare(input)).rejects.toMatchObject({
        code: "invalid_api_key",
        status: 401,
      });
      expect(m.allocate).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { ...endpoint, status: "disabled" },
    { ...endpoint, currentRevision: null },
  ])(
    "fails closed when an endpoint is disabled during admission: %j",
    async (value) => {
      m.lockedEndpoint.mockResolvedValue(value);
      await expect(prepare(input)).rejects.toMatchObject({
        code: "endpoint_disabled",
        status: 403,
      });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { endpointId: "other", status: "active" },
    { endpointId: "endpoint", status: "disabled" },
  ])("rechecks the client under the admission lock: %j", async (value) => {
    m.client.mockResolvedValue(value);
    await expect(prepare(input)).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });
  it.each([
    "endpointOutput",
    "clientOutput",
    "workspaceOutput",
    "endpointStored",
    "clientStored",
    "workspaceStored",
  ])(
    "reserves quota before admitting more work when %s is exhausted",
    async (field) => {
      m.raw.mockImplementation(async (strings: TemplateStringsArray) =>
        strings.join("").includes('AS "endpointOutput"')
          ? [{ ...zeroBudget, [field]: BigInt(1000000000) }]
          : [],
      );
      await expect(prepare(input)).rejects.toMatchObject({
        code: "resource_limit_exceeded",
        status: 429,
      });
      expect(m.create).not.toHaveBeenCalled();
      expect(m.allocate).not.toHaveBeenCalled();
    },
  );
  it("fails closed when budget accounting is unavailable", async () => {
    m.raw.mockResolvedValue([]);
    await expect(prepare(input)).rejects.toMatchObject({
      code: "internal_error",
      status: 500,
    });
  });
  it.each(["endpoint", "client", "a2a-endpoint", "a2a-client"])(
    "counts %s concurrency against admission",
    async (kind) => {
      if (kind === "endpoint")
        m.count.mockResolvedValueOnce(10).mockResolvedValueOnce(0);
      if (kind === "client")
        m.count.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
      if (kind === "a2a-endpoint")
        m.taskCount.mockResolvedValueOnce(10).mockResolvedValueOnce(0);
      if (kind === "a2a-client")
        m.taskCount.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
      await expect(prepare(input)).rejects.toMatchObject({
        code: "concurrency_limit_exceeded",
        status: 429,
        retryAfter: 1,
      });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("conceals foreign conversations and detects deletion after locking", async () => {
    await expect(
      prepare({ ...input, conversationId: "foreign" }),
    ).rejects.toMatchObject({ code: "conversation_not_found", status: 404 });
    expect(m.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicId: "foreign",
          endpointId: "endpoint",
          clientId: "client",
          subjectHash: "subject",
          deletingAt: null,
        },
      }),
    );
    m.conversation
      .mockResolvedValueOnce({ id: "conversation" })
      .mockResolvedValueOnce(null);
    await expect(
      prepare({ ...input, conversationId: "deleted" }),
    ).rejects.toMatchObject({ code: "conversation_not_found", status: 404 });
  });
  it("rejects busy conversations and excessive transcript creation", async () => {
    m.conversation.mockResolvedValue({ id: "conversation" });
    m.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    await expect(
      prepare({ ...input, conversationId: "busy" }),
    ).rejects.toMatchObject({ code: "conversation_busy", status: 409 });
    m.conversationCount.mockResolvedValue(100);
    await expect(prepare(input)).rejects.toMatchObject({
      code: "resource_limit_exceeded",
      status: 429,
    });
  });
  it("rejects idempotency conflicts before resource allocation", async () => {
    m.latest.mockResolvedValue({ ...run, requestHash: "different" });
    await expect(
      prepare({ ...input, idempotencyKey: "stable" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(m.allocate).not.toHaveBeenCalled();
  });
  it("retries only serializable admission conflicts and bounds retry attempts", async () => {
    m.transaction.mockRejectedValue({ code: "P2034" });
    await expect(prepare(input)).rejects.toEqual({ code: "P2034" });
    expect(m.transaction).toHaveBeenCalledTimes(5);
    m.transaction.mockClear().mockRejectedValue({ code: "P2002" });
    await expect(prepare(input)).rejects.toEqual({ code: "P2002" });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    m.transaction.mockClear();
    await expect(
      prepare({ ...input, idempotencyKey: "stable" }),
    ).rejects.toEqual({ code: "P2002" });
    expect(m.transaction).toHaveBeenCalledTimes(5);
  });
  it.each([
    ["quota_exceeded", "resource_limit_exceeded", 429],
    ["provisioning", "runtime_unavailable", 503],
    ["unavailable", "runtime_unavailable", 503],
  ])(
    "converts allocation %s into a public failure and releases the durable run",
    async (code, expectedCode, status) => {
      m.allocate.mockRejectedValue(
        new AgentEndpointRuntimeAllocationError(
          code as "quota_exceeded",
          "private infrastructure details",
        ),
      );
      await expect(prepare(input)).rejects.toMatchObject({
        code: expectedCode,
        status,
      });
      expect(m.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          subjectHash: "subject",
          status: "provisioning",
          inputCharacters: 5,
          publicConversationId: null,
        }),
      });
      expect(m.update).toHaveBeenCalledWith({
        where: { id: "run", status: { in: ["provisioning", "running"] } },
        data: expect.objectContaining({
          status: "failed",
          errorCode: expectedCode,
          completedAt: expect.any(Date),
        }),
      });
      expect(m.unregister).toHaveBeenCalled();
    },
  );
  it("aborts expired workers before new provisioning and consumes a caller-supplied rate admission", async () => {
    const raw = m.raw.getMockImplementation();
    m.raw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join("").includes("WITH candidates")
          ? [{ publicId: "expired" }]
          : raw?.(strings, ...values),
    );
    await expect(
      prepare({
        ...input,
        rateLimit: {
          headers: new Headers(),
          limit: 60,
          remaining: 59,
          reset: 2000000000,
        },
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(m.abort).toHaveBeenCalledWith("expired");
    expect(m.rate).not.toHaveBeenCalled();
  });
});

describe("public response execution state and transcript outcomes", () => {
  const prepared: PreparedAgentResponse = {
    runId: "run",
    responseId: "response",
    requestId: "request",
    endpointId: "endpoint",
    endpointPublicId: "public",
    endpointRevision: 2,
    clientId: "client",
    subjectHash: "subject",
    publicConversationId: "public-conversation",
    input: "Hello",
    stream: false,
    timeoutSeconds: 60,
    replay: false,
    rateLimitHeaders: new Headers(),
  };
  const loaded = {
    ...run,
    endpointId: "endpoint",
    runtimeAllocationId: "allocation",
    runtimeAllocation: { runtimeAgentId: "hidden" },
    publicConversation: {
      id: "public-conversation",
      conversation: {
        id: "conversation",
        runtimeSessionId: "session",
        runtimeSessionKey: "session-key",
      },
    },
  };
  beforeEach(() => {
    m.run
      .mockResolvedValueOnce(loaded)
      .mockResolvedValueOnce({ id: "run" })
      .mockResolvedValueOnce({
        id: "run",
        deadlineAt: new Date(Date.now() + 60000),
      })
      .mockResolvedValue({
        ...run,
        status: "completed",
        outputText: "Answer",
        outputCharacters: 6,
      });
    m.executionAgent.mockResolvedValue({
      id: "hidden",
      workspaceId: "workspace",
      runtime: { kind: "hermes" },
    });
    m.lease.mockReturnValue({ release: m.release });
    m.messages.mockResolvedValue([]);
    m.aggregate.mockResolvedValue({ _max: { sequence: null } });
    m.raw.mockResolvedValue([{ id: "run" }]);
    m.stream.mockImplementation(async ({ onDelta }) => {
      await onDelta("Answer");
      return "Answer";
    });
  });
  it("persists complete user/assistant turns and accounting before exposing completed output", async () => {
    const onDelta = vi.fn();
    expect(await execute(prepared, { onDelta })).toMatchObject({
      status: "completed",
      output_text: "Answer",
    });
    expect(onDelta).toHaveBeenCalledWith("Answer");
    expect(m.saveMessages).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          role: "user",
          sequence: 1,
          textCharacters: 5,
        }),
        expect.objectContaining({
          role: "assistant",
          sequence: 2,
          textCharacters: 6,
        }),
      ],
    });
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.unregister).toHaveBeenCalledTimes(1);
  });
  it("replays durable responses without restarting a worker", async () => {
    m.run.mockReset().mockResolvedValue(run);
    expect(await execute({ ...prepared, replay: true })).toMatchObject({
      status: "running",
    });
    expect(m.stream).not.toHaveBeenCalled();
    expect(m.unregister).not.toHaveBeenCalled();
    m.run.mockResolvedValue(null);
    await expect(execute({ ...prepared, replay: true })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it.each(["cancelled", "missing"])(
    "fails safely when execution admission is %s",
    async (state) => {
      m.run.mockReset().mockResolvedValue(null);
      m.latest.mockResolvedValue(
        state === "cancelled" ? { status: "cancelled" } : null,
      );
      await expect(execute(prepared)).rejects.toMatchObject({
        code: state === "cancelled" ? "cancelled" : "runtime_unavailable",
      });
      expect(m.saveMessages).not.toHaveBeenCalled();
      expect(m.unregister).toHaveBeenCalled();
    },
  );
  it.each([
    "conversation",
    "runtime-agent",
    "allocation",
    "session",
    "session-key",
    "endpoint",
    "workspace",
    "agent",
    "maintenance",
  ])("rejects missing or unsafe execution binding: %s", async (reason) => {
    const changed = {
      ...loaded,
      ...(reason === "conversation" ? { publicConversation: null } : {}),
      ...(reason === "runtime-agent" ? { runtimeAllocation: null } : {}),
      ...(reason === "allocation" ? { runtimeAllocationId: null } : {}),
      ...(["session", "session-key"].includes(reason)
        ? {
            publicConversation: {
              ...loaded.publicConversation,
              conversation: {
                ...loaded.publicConversation.conversation,
                ...(reason === "session"
                  ? { runtimeSessionId: null }
                  : { runtimeSessionKey: null }),
              },
            },
          }
        : {}),
      ...(reason === "endpoint" ? { endpointId: "foreign" } : {}),
    };
    m.run.mockReset().mockResolvedValue(changed);
    if (reason === "workspace") m.lockedEndpoint.mockResolvedValue(null);
    if (reason === "agent")
      m.executionAgent.mockResolvedValue({ runtime: { kind: "pi" } });
    if (reason === "maintenance") m.lease.mockReturnValue(null);
    await expect(execute(prepared)).rejects.toMatchObject({
      code:
        reason === "maintenance"
          ? "runtime_maintenance"
          : "runtime_unavailable",
    });
    expect(m.stream).not.toHaveBeenCalled();
    expect(m.saveMessages).not.toHaveBeenCalled();
  });
  it.each(["admission", "completion", "deadline", "commit"])(
    "does not publish output after cancellation or deadline at %s",
    async (stage) => {
      m.run
        .mockReset()
        .mockResolvedValueOnce(loaded)
        .mockResolvedValueOnce(stage === "admission" ? null : { id: "run" })
        .mockResolvedValueOnce(
          stage === "completion"
            ? null
            : {
                id: "run",
                deadlineAt: new Date(
                  stage === "deadline" ? 0 : Date.now() + 60000,
                ),
              },
        );
      if (stage === "commit") m.raw.mockResolvedValue([]);
      await expect(execute(prepared)).rejects.toMatchObject({
        code: ["deadline", "commit"].includes(stage)
          ? "request_timeout"
          : "cancelled",
      });
      expect(m.release).toHaveBeenCalledTimes(1);
      expect(m.unregister).toHaveBeenCalledTimes(1);
      if (stage !== "commit") expect(m.saveMessages).not.toHaveBeenCalled();
    },
  );
  it.each([
    new Error("private upstream details"),
    new HermesResponseTooLargeError(),
  ])(
    "maps runtime errors without persisting partial transcripts",
    async (error) => {
      m.stream.mockRejectedValue(error);
      await expect(execute(prepared)).rejects.toMatchObject({
        code:
          error instanceof HermesResponseTooLargeError
            ? "response_too_large"
            : "upstream_error",
      });
      expect(m.saveMessages).not.toHaveBeenCalled();
      expect(m.release).toHaveBeenCalledTimes(1);
    },
  );
  it("honors caller cancellation and removes its listener after failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    m.stream.mockImplementation(async ({ signal }) => {
      signal.throwIfAborted();
    });
    await expect(
      execute(prepared, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          errorCode: "cancelled",
        }),
      }),
    );
    expect(m.release).toHaveBeenCalledTimes(1);
  });
  it("admits only complete prior turns in chronological order", async () => {
    m.messages
      .mockResolvedValueOnce([
        { id: "orphan", role: "user", textCharacters: 1 },
        { id: "assistant", role: "assistant", textCharacters: 6 },
        { id: "user", role: "user", textCharacters: 5 },
      ])
      .mockResolvedValueOnce([
        {
          id: "assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Earlier answer" }],
        },
        {
          id: "user",
          role: "user",
          parts: [{ type: "text", text: "Earlier question" }],
        },
      ]);
    await execute(prepared);
    expect(m.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ id: "user" }),
          expect.objectContaining({ id: "assistant" }),
          expect.objectContaining({
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          }),
        ],
      }),
    );
  });
});
