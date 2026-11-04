import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { sanitizeLog } from "@/lib/observability/redaction";
import { getLogContext, withLogContext } from "@/lib/observability/context";

const records = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/events", () => ({ recordEvent: records }));
import { withRequestLogging } from "@/lib/observability/http";

describe("structured logging safety", () => {
  it("redacts credentials and Error causes without losing large payloads or usage", () => {
    const error = new Error("Authorization: Bearer fixture-private-value", {
      cause: new Error('password="do-not-record"'),
    });
    const circular: Record<string, unknown> = {
      error,
      apiKey: "private",
      inputTokens: 42,
      outputTokens: 7,
      headers: { cookie: "private" },
      nested: ["known-value"],
      text: `${"字".repeat(150_000)} known-value tail`,
    };
    circular.self = circular;
    const result = sanitizeLog(circular, ["known-value"]);
    const text = JSON.stringify(result.data);
    expect(text).not.toContain("fixture-private-value");
    expect(text).not.toContain("do-not-record");
    expect(text).not.toContain("known-value");
    expect(result.truncated).toBe(false);
    expect(result.data).toMatchObject({
      apiKey: "[REDACTED]",
      inputTokens: 42,
      outputTokens: 7,
      self: "[CIRCULAR]",
      text: `${"字".repeat(150_000)} [REDACTED] tail`,
      error: { cause: { message: 'password="[REDACTED]"' } },
    });
  });

  it("retains every array item, object key and long key while redacting the tail", () => {
    const longKey = `${"key".repeat(100)}known-value`;
    const input = {
      items: Array.from({ length: 350 }, (_, index) => ({
        index,
        value: index === 349 ? "known-value" : "safe",
      })),
      fields: Object.fromEntries(
        Array.from({ length: 350 }, (_, index) => [
          `field${index}`,
          index === 349 ? "known-value" : index,
        ]),
      ),
      [longKey]: "safe",
      date: new Date("2026-01-01T00:00:00Z"),
      bigint: BigInt("9007199254740993"),
      totalTokens: 49,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      usedTokens: 7,
      maxTokens: 100,
    };
    const result = sanitizeLog(input, ["known-value"]);
    expect(result.truncated).toBe(false);
    expect(result.data).toMatchObject({
      items: input.items.map((item) => ({
        ...item,
        value: item.index === 349 ? "[REDACTED]" : "safe",
      })),
      fields: { field349: "[REDACTED]" },
      [`${"key".repeat(100)}[REDACTED]`]: "safe",
      date: "2026-01-01T00:00:00.000Z",
      bigint: "9007199254740993",
      totalTokens: 49,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      usedTokens: 7,
      maxTokens: 100,
    });
    expect(Object.keys((result.data as typeof input).fields)).toHaveLength(350);
    expect(JSON.stringify(result.data)).not.toContain("known-value");
  });

  it("handles deep payloads iteratively and distinguishes shared references from cycles", () => {
    const leaf: Record<string, unknown> = {
      text: "known-value",
      password: "private",
    };
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.leaf = leaf;
    cursor.root = root;
    const result = sanitizeLog(root, ["known-value"]);
    let output = result.data as Record<string, unknown>;
    for (let depth = 0; depth < 20_000; depth += 1)
      output = output.next as Record<string, unknown>;
    expect(output).toEqual({
      leaf: { text: "[REDACTED]", password: "[REDACTED]" },
      root: "[CIRCULAR]",
    });
    const error = new Error("shared");
    error.cause = error;
    expect(
      sanitizeLog({ first: leaf, second: leaf, errors: [error, error] }, [
        "known-value",
      ]).data,
    ).toMatchObject({
      first: { text: "[REDACTED]" },
      second: { text: "[REDACTED]" },
      errors: [{ cause: "[CIRCULAR]" }, { cause: "[CIRCULAR]" }],
    });
    expect(result.truncated).toBe(false);
  });

  it("preserves hostile own keys without mutating object prototypes", () => {
    const input = JSON.parse(
      '{"__proto__":{"safe":true},"constructor":"known-value"}',
    );
    const result = sanitizeLog(input, ["known-value"]);
    expect(Object.hasOwn(result.data as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
    expect(JSON.stringify(result.data)).toContain('"constructor":"[REDACTED]"');
  });

  it("isolates concurrent roots and links child spans without leaking non-context fields", async () => {
    const contexts = await Promise.all(
      ["a", "b"].map((actorId) =>
        withLogContext({ actorId }, async () => {
          const root = assertDefined(getLogContext());
          await new Promise((resolve) => setTimeout(resolve, 2));
          return withLogContext({}, () => ({
            root: { ...root },
            child: { ...assertDefined(getLogContext()) },
          }));
        }),
      ),
    );
    expect(contexts[0].root.traceId).not.toBe(contexts[1].root.traceId);
    expect(contexts[0].child.actorId).toBe("a");
    expect(contexts[1].child.actorId).toBe("b");
    expect(contexts[0].child.parentSpanId).toBe(contexts[0].root.spanId);
    expect(contexts[0].child.spanId).not.toBe(contexts[0].root.spanId);
    expect(getLogContext()).toBeUndefined();
  });

  it("records early authorization failures and ignores untrusted incoming request IDs", async () => {
    records.mockClear();
    records.mockImplementation(async (entry) => {
      expect(getLogContext()?.requestId).not.toBe("spoofed");
      return entry;
    });
    const handler = withRequestLogging(
      "/test/[secret]",
      async () => new Response(null, { status: 401 }),
    );
    const response = await handler(
      new Request("http://localhost/test/do-not-log?token=private", {
        headers: { "x-request-id": "spoofed" },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(records).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/test/[secret]",
        httpStatus: 401,
        outcome: "denied",
      }),
    );
    expect(JSON.stringify(records.mock.calls)).not.toContain("do-not-log");
  });

  it("preserves SSE bytes and records completion only when the stream finishes", async () => {
    records.mockReset();
    records.mockResolvedValue(undefined);
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    });
    const response = await withRequestLogging(
      "/stream",
      async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        }),
    )(new Request("http://localhost/stream"));
    expect(await response.text()).toBe("data: ok\n\n");
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("records SSE cancellation and stream errors once without replacing the error", async () => {
    records.mockReset();
    records.mockResolvedValue(undefined);
    const cancelled = vi.fn();
    const response = await withRequestLogging(
      "/stream",
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "content-type": "text/event-stream" },
        }),
    )(new Request("http://localhost/stream"));
    await assertDefined(response.body).cancel();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "cancelled" }),
    );
    records.mockClear();
    const error = new Error("stream failed");
    const failed = await withRequestLogging(
      "/stream",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
    )(new Request("http://localhost/stream"));
    await expect(failed.text()).rejects.toBe(error);
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "error", error }),
    );
  });
});
