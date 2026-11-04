import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ logEvent: { create: mocks.create } }),
  },
}));
vi.mock("@/lib/observability/settings", () => ({
  getLogSettings: mocks.settings,
}));
import { recordEvent } from "@/lib/observability/events";
import { withLogContext, enrichLogContext } from "@/lib/observability/context";
import { readResponseText } from "@/lib/observability/payload";
import { logRequest } from "@/lib/observability/log";
import { recordA2AEvent } from "@/lib/observability/a2a-log";
import { getLogContext } from "@/lib/observability/context";
import type { LocalA2AGrant } from "@/lib/a2a/principal";

const grant: LocalA2AGrant = {
  kind: "local",
  workspaceId: "ws",
  actorId: "actor",
  agentId: "agent",
  agentRevisionId: "revision-1",
  targetBinding: "binding",
  ownerKey: "private-owner",
  expiresAt: Date.now() + 60_000,
  scopes: ["a2a:send"],
  maxConcurrent: 1,
  timeoutSeconds: 60,
  retentionDays: 1,
  ancestorTaskIds: [],
  ancestorAgentIds: [],
};
const capture = (includeAgentContent = false) => ({
  field: "workspaceId",
  id: "ws",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  includeAgentContent,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({
    eventDays: 30,
    detailDays: 7,
    auditDays: 180,
    captures: [capture()],
  });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const event = {
  domain: "agent" as const,
  workspaceId: "ws",
  eventName: "test.call",
};
describe("typed lazy payload policy", () => {
  it("metadata-only is the default even during diagnostic capture", async () => {
    const detail = vi.fn(() => ({ text: "private" }));
    await recordEvent({ ...event, detail });
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it("Agent errors never serialize business text through the default metadata policy", async () => {
    await recordEvent({
      ...event,
      error: new Error("private reply inside an SDK error"),
      attributes: {
        text: "private reply",
        inputTokens: 3,
        outputTokens: 4,
        firstOutputMs: 9,
      },
    });
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "private reply",
    );
    expect(
      JSON.stringify(vi.mocked(process.stderr.write).mock.calls),
    ).not.toContain("private reply");
    expect(mocks.create.mock.calls[0][0].data.attributes.data).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      firstOutputMs: 9,
    });
  });
  it("diagnostic capture alone cannot collect agent content", async () => {
    const detail = vi.fn(() => ({ text: "private" }));
    await recordEvent({ ...event, payloadPolicy: "agent-content", detail });
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it("explicit agent capture is bounded in lifetime and does not emit payloads to stderr", async () => {
    mocks.settings.mockResolvedValue({
      detailDays: 7,
      captures: [capture(true)],
    });
    const detail = vi.fn(() => ({
      text: "business-private",
      apiKey: "secret-api-key",
    }));
    await recordEvent({
      ...event,
      payloadPolicy: "agent-content",
      detail,
      secrets: ["secret-api-key"],
    });
    expect(detail).toHaveBeenCalledOnce();
    const data = mocks.create.mock.calls[0][0].data;
    expect(JSON.stringify(data.detail.create.data)).toContain(
      "business-private",
    );
    expect(JSON.stringify(data)).not.toContain("secret-api-key");
    expect(data.detail.create.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 86400_000,
    );
    expect(
      JSON.stringify(vi.mocked(process.stderr.write).mock.calls),
    ).not.toContain("business-private");
  });
  it.each(["forbidden", "agent-content"] as const)(
    "parent suppression cannot be overridden by a child for %s",
    async (payloadPolicy) => {
      mocks.settings.mockResolvedValue({
        detailDays: 7,
        captures: [capture(true)],
      });
      const detail = vi.fn(() => ({ text: "private" }));
      await withLogContext({ workspaceId: "ws", suppressPayload: true }, () =>
        withLogContext({ suppressPayload: false }, async () => {
          enrichLogContext({ suppressPayload: false });
          await recordEvent({
            ...event,
            payloadPolicy,
            detail,
            suppressPayload: false,
            error: new Error("private error content"),
            attributes: { text: "private" },
          });
        }),
      );
      expect(detail).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
        "private error content",
      );
      expect(
        JSON.stringify(vi.mocked(process.stderr.write).mock.calls),
      ).not.toContain("private");
    },
  );
  it("expired or wrong-resource capture never calls the payload factory", async () => {
    mocks.settings.mockResolvedValue({
      detailDays: 7,
      captures: [
        { ...capture(true), id: "another" },
        { ...capture(true), expiresAt: new Date(0).toISOString() },
      ],
    });
    const detail = vi.fn();
    await recordEvent({ ...event, payloadPolicy: "agent-content", detail });
    expect(detail).not.toHaveBeenCalled();
  });
  it("forbidden overrides even an explicit content capture", async () => {
    mocks.settings.mockResolvedValue({
      detailDays: 7,
      captures: [capture(true)],
    });
    const detail = vi.fn();
    await recordEvent({
      ...event,
      payloadPolicy: "forbidden",
      detail,
      error: new Error("private prompt"),
    });
    expect(detail).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "private prompt",
    );
  });
  it("automatically captures full redacted deployment MCP detail without a diagnostic window", async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [] });
    await withLogContext(
      { workspaceId: "ws", secrets: ["runtime-secret-value"] },
      () =>
        recordEvent({
          domain: "mcp",
          eventName: "mcp.rpc",
          deploymentId: "deployment-1",
          rpcMethod: "tools/call",
          detail: {
            request: {
              method: "tools/call",
              params: {
                name: "echo",
                arguments: {
                  value: "runtime-secret-value",
                  apiKey: "private-key",
                },
              },
            },
            response: {
              result: {
                content: Array.from({ length: 150 }, (_, index) => ({
                  type: "text",
                  text: `${"x".repeat(1000)} ${index === 149 ? "runtime-secret-value" : "safe"} tail`,
                })),
              },
            },
          },
        }),
    );
    const detail = mocks.create.mock.calls[0][0].data.detail.create;
    expect(detail.data).toMatchObject({
      workspaceMcpPayload: true,
      payload: {
        request: {
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { value: "[REDACTED]", apiKey: "[REDACTED]" },
          },
        },
      },
    });
    expect(detail.truncated).toBe(false);
    expect(detail.data.payload.response.result.content).toHaveLength(150);
    expect(detail.data.payload.response.result.content[149].text).toBe(
      `${"x".repeat(1000)} [REDACTED] tail`,
    );
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "runtime-secret-value",
    );
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "private-key",
    );
  });
  it("keeps complete allowed messages, attributes and errors with tail secrets redacted", async () => {
    const message = `${"message ".repeat(1500)}runtime-secret-value tail`;
    const error = new Error(
      `${"failure ".repeat(1500)}runtime-secret-value tail`,
      {
        cause: new Error("password=private"),
      },
    );
    const fields = Object.fromEntries(
      Array.from({ length: 180 }, (_, index) => [`field${index}`, index]),
    );
    await recordEvent({
      domain: "system",
      workspaceId: "ws",
      eventName: "test.full-metadata",
      message,
      error,
      attributes: { fields, text: message },
      secrets: ["runtime-secret-value"],
    });
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.message).toBe(
      message.replace("runtime-secret-value", "[REDACTED]"),
    );
    expect(data.attributes.data.fields).toEqual(fields);
    expect(data.attributes.data.text).toBe(data.message);
    expect(data.detail.create.data.error.message).toBe(
      error.message.replace("runtime-secret-value", "[REDACTED]"),
    );
    expect(data.detail.create.truncated).toBe(false);
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "runtime-secret-value",
    );
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(
      "password=private",
    );
  });

  it("does not hold up a business response and retains context and MCP semantic errors", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const { promise: completed, resolve: persisted } =
      Promise.withResolvers<void>();
    mocks.create.mockImplementationOnce(async () => {
      persisted();
    });
    await withLogContext(
      {
        workspaceId: "ws",
        actorId: "original",
        secrets: ["runtime-secret-value"],
      },
      async () => {
        await logRequest({
          workspaceId: "ws",
          deploymentId: "deployment-1",
          method: "POST",
          path: "/mcp/deployment-1/rpc#tools/call:slow",
          statusCode: 200,
          durationMs: 1,
          response,
        });
        enrichLogContext({ actorId: "changed" });
      },
    );
    expect(mocks.create).not.toHaveBeenCalled();
    const text = `${"failure ".repeat(6000)}runtime-secret-value tail`;
    const body = JSON.stringify({
      result: { isError: true, content: [{ type: "text", text }] },
    });
    controller.enqueue(new TextEncoder().encode(body));
    controller.close();
    expect(await response.text()).toBe(body);
    await completed;
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.actorId).toBe("original");
    expect(data.outcome).toBe("error");
    expect(data.message).toBe(
      text.replace("runtime-secret-value", "[REDACTED]"),
    );
    expect(
      data.detail.create.data.payload.response.result.content[0].text,
    ).toBe(data.message);
    expect(data.detail.create.truncated).toBe(false);
  });
  it("does not auto-capture deployment MCP payloads in an explicitly suppressed context", async () => {
    mocks.settings.mockResolvedValue({ detailDays: 7, captures: [] });
    const detail = vi.fn(() => ({
      request: "private input",
      response: "private output",
    }));
    await withLogContext({ workspaceId: "ws", suppressPayload: true }, () =>
      recordEvent({
        domain: "mcp",
        eventName: "mcp.rpc",
        deploymentId: "deployment-1",
        detail,
      }),
    );
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it("exposes Agent-session MCP bodies to the workspace but keeps other captured API bodies private", async () => {
    mocks.settings.mockResolvedValue({
      detailDays: 7,
      captures: [capture(true)],
    });
    for (const fields of [
      {
        deploymentId: "deployment-1",
        agentId: "agent-1",
        payloadPolicy: "agent-content" as const,
      },
      { payloadPolicy: "diagnostic" as const },
    ]) {
      await recordEvent({
        workspaceId: "ws",
        domain: "mcp",
        eventName: "gateway.request",
        ...fields,
        detail: { request: "private input", response: "private output" },
      });
    }
    const [agentCall, apiCall] = mocks.create.mock.calls.map(
      ([entry]) => entry.data.detail.create.data,
    );
    expect(agentCall).toMatchObject({
      workspaceMcpPayload: true,
      payload: { request: "private input" },
    });
    expect(apiCall).toMatchObject({
      workspaceMcpPayload: false,
      payload: { request: "private input" },
    });
  });
  it("captures authorized request boundaries in a detached span without disabling execution suppression", async () => {
    mocks.settings.mockResolvedValue({
      eventDays: 0.5,
      detailDays: 7,
      captures: [],
    });
    await withLogContext(
      {
        workspaceId: "wrong",
        actorId: "wrong",
        suppressPayload: true,
        secrets: ["fixture-secret"],
      },
      async () => {
        const parent = assertDefined(getLogContext());
        await recordA2AEvent({
          eventName: "a2a.request",
          binding: { grant, taskId: "task" },
          metadata: {
            direction: "inbound",
            transport: "jsonrpc",
            taskId: "untrusted",
          },
          outcome: "success",
          request: { text: "hello fixture-secret password=private" },
          responseKind: "none",
          responseComplete: true,
          truncated: true,
        });
        const data = mocks.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
          workspaceId: "ws",
          actorId: "actor",
          agentId: "agent",
          traceId: parent.traceId,
          parentSpanId: parent.spanId,
          attributes: { data: { a2a: { taskId: "task", rootTaskId: "task" } } },
        });
        expect(data.spanId).not.toBe(parent.spanId);
        expect(data.a2a).toBeUndefined();
        expect(data.detail.create).toMatchObject({
          truncated: true,
          data: {
            workspaceMcpPayload: false,
            payload: {
              request: { text: 'hello [REDACTED] password="[REDACTED]"' },
              responseKind: "none",
              responseComplete: true,
            },
          },
        });
        expect(data.detail.create.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + 43_200_000,
        );
        expect(getLogContext()?.suppressPayload).toBe(true);
        expect(
          JSON.stringify(vi.mocked(process.stderr.write).mock.calls),
        ).not.toContain("hello");
        expect(JSON.stringify(data)).not.toContain("private-owner");
      },
    );
  });
  it.each(["unbound", "denied", "started"] as const)(
    "never evaluates payload readers for %s requests",
    async (kind) => {
      const reader = vi.fn(() => "private");
      await recordA2AEvent({
        eventName: kind === "started" ? "a2a.task.started" : "a2a.request",
        binding: kind === "unbound" ? undefined : { grant },
        metadata: { direction: "inbound", transport: "entry" },
        outcome: kind === "denied" ? "denied" : "success",
        request: reader,
        response: reader,
      });
      expect(reader).not.toHaveBeenCalled();
      expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
    },
  );
  it("request-response still obeys ordinary parent suppression", async () => {
    const detail = vi.fn();
    await withLogContext({ suppressPayload: true }, () =>
      recordEvent({ ...event, payloadPolicy: "request-response", detail }),
    );
    expect(detail).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].data.detail).toBeUndefined();
  });
  it("invalid metadata and throwing projections cannot reject the business operation", async () => {
    await recordA2AEvent({
      eventName: "a2a.request",
      binding: { grant },
      metadata: {
        direction: "inbound",
        transport: "entry",
        rpcErrorCode: Infinity,
      },
      outcome: "error",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await recordA2AEvent({
      eventName: "a2a.request",
      binding: { grant },
      metadata: {
        direction: "inbound",
        transport: "entry",
        taskState: "TASK_STATE_private-prompt",
      },
      outcome: "error",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await recordA2AEvent({
      eventName: "a2a.request",
      binding: { grant },
      metadata: { direction: "inbound", transport: "entry" },
      outcome: "success",
      request: () => {
        throw new Error("private");
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
describe("complete finite response reader", () => {
  it("does not consume the original response", async () => {
    const response = Response.json({ hello: "world" });
    expect(await readResponseText(response)).toContain("world");
    expect(await response.json()).toEqual({ hello: "world" });
  });
  it("retains finite responses larger than the former byte budget", async () => {
    const body = `${"字".repeat(50_000)} tail`;
    expect(await readResponseText(new Response(body))).toBe(body);
  });
  it("retains finite responses that take longer than the former deadline", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("start "));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("tail"));
              controller.close();
            }, 300);
          },
        }),
      );
      const reading = readResponseText(response);
      await vi.advanceTimersByTimeAsync(300);
      expect(await reading).toBe("start tail");
    } finally {
      vi.useRealTimers();
    }
  });
  it("never reads a live SSE stream", async () => {
    const response = new Response(new ReadableStream(), {
      headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
    });
    const clone = vi.spyOn(response, "clone");
    expect(await readResponseText(response)).toBeNull();
    expect(clone).not.toHaveBeenCalled();
  });
});
