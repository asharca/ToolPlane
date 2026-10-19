// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { privateJson, readSandboxJson } from "@/lib/sandboxes/http-body";

describe("sandbox bounded JSON request parsing", () => {
  it("decodes UTF-8 split across chunks without corrupting Unicode", async () => {
    const bytes = new TextEncoder().encode('{"name":"密码"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const request = new Request("https://app.test/", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readSandboxJson(request)).resolves.toEqual({ name: "密码" });
    expect(stream.locked).toBe(false);
  });
  it.each([
    ["text/plain", "{}", {}, 415],
    ["application/json", "{}", { "content-length": "16385" }, 413],
    ["application/json", "{bad", {}, 400],
    ["application/json", undefined, {}, 400],
  ] as const)(
    "rejects unsupported, oversized, malformed or absent bodies",
    async (type, body, headers, status) => {
      const request = new Request("https://app.test/", {
        method: "POST",
        headers: { "content-type": type, ...headers },
        body,
      });
      await expect(readSandboxJson(request)).rejects.toMatchObject({ status });
    },
  );
  it("cancels streaming oversized requests even if cancellation itself fails", async () => {
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    const request = new Request("https://app.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readSandboxJson(request, 4)).rejects.toMatchObject({
      status: 413,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it("rejects invalid UTF-8 and read failures with a safe body error", async () => {
    const invalid = new Request("https://app.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Uint8Array.of(0xff),
    });
    await expect(readSandboxJson(invalid)).rejects.toMatchObject({
      status: 400,
      message: "Invalid request body.",
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private transport error"));
      },
    });
    const request = new Request("https://app.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readSandboxJson(request)).rejects.toMatchObject({
      status: 400,
      message: "Invalid request body.",
    });
    expect(stream.locked).toBe(false);
  });
  it("always prevents shared caching for success and error JSON", async () => {
    for (const status of [200, 400]) {
      const response = privateJson({ status }, status);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ status });
    }
  });
});
