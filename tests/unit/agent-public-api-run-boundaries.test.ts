// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  latest: vi.fn(),
  update: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agentRun: {
      findFirst: mocks.find,
      findUnique: mocks.latest,
      updateMany: mocks.update,
    },
  },
}));
vi.mock("@/lib/agents/public-api/run-control", () => ({
  abortAgentApiRun: mocks.abort,
}));
import {
  agentRunResponseView,
  getAgentResponseForPrincipal,
  requestAgentResponseCancellation,
} from "@/lib/agents/public-api/runs";
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
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(run);
  mocks.latest.mockResolvedValue(null);
  mocks.update.mockResolvedValue({ count: 1 });
});
describe("historical public response reads and draining", () => {
  it("conceals foreign responses with endpoint, client and subject constraints", async () => {
    mocks.find.mockResolvedValueOnce(null);
    expect(await getAgentResponseForPrincipal(scope)).toBeNull();
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicId: "response",
          clientId: "client",
          endpoint: { publicId: "public" },
          subjectHash: "subject",
        },
      }),
    );
    expect(
      await getAgentResponseForPrincipal({ ...scope, subjectHash: null }),
    ).toMatchObject({
      id: "response",
      status: "running",
      output: [],
      output_text: "",
      conversation_id: "conversation-public",
    });
    expect(mocks.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          publicId: "response",
          clientId: "client",
          endpoint: { publicId: "public" },
        },
      }),
    );
  });
  it("preserves partial historical output and stable public errors", () => {
    expect(
      agentRunResponseView({
        ...run,
        status: "failed",
        errorCode: "request_timeout",
        outputText: "Partial",
        outputCharacters: 7,
        durationMs: 123,
        publicConversation: null,
      }),
    ).toMatchObject({
      conversation_id: null,
      output_text: "Partial",
      error: { code: "request_timeout", message: expect.any(String) },
      usage: { input_characters: 5, output_characters: 7, duration_ms: 123 },
    });
  });
  it("does not mutate or resume terminal runs", async () => {
    mocks.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...run, status: "completed" });
    expect(await requestAgentResponseCancellation(scope)).toBeNull();
    expect(await requestAgentResponseCancellation(scope)).toMatchObject({
      status: "completed",
      cancellation_requested: false,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });
  it.each(["provisioning", "running"])(
    "drains a bound old %s run without scheduling new execution",
    async (status) => {
      mocks.find.mockResolvedValue({ ...run, status });
      mocks.latest.mockResolvedValue({
        ...run,
        status: "cancelled",
        errorCode: "cancelled",
      });
      expect(await requestAgentResponseCancellation(scope)).toMatchObject({
        status: "cancelled",
        cancellation_requested: true,
      });
      expect(mocks.update).toHaveBeenCalledWith({
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
      expect(mocks.abort).toHaveBeenCalledWith("response");
    },
  );
  it("does not abort after concurrent completion wins the cancellation claim", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await requestAgentResponseCancellation(scope)).toMatchObject({
      cancellation_requested: false,
    });
    expect(mocks.abort).not.toHaveBeenCalled();
  });
});
