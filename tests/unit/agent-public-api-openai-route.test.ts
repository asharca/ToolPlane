// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (
    _route: string,
    handler: (request: Request) => Promise<Response>,
  ) => handler,
}));
vi.mock("@/lib/db", () => {
  throw new Error(
    "Retired OpenAI execution must not load a runtime allocator or database",
  );
});
vi.mock("@/lib/agents/public-api/auth", () => {
  throw new Error(
    "Retired OpenAI execution must not enter legacy authentication and dispatch",
  );
});
import { POST } from "@/app/api/openai/v1/chat/completions/route";
describe("retired OpenAI-compatible execution", () => {
  it.each([
    "{",
    JSON.stringify({
      model: "old-endpoint",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  ])("rejects old execution without fallback for %s", async (body) => {
    const response = await POST(
      new Request("http://localhost/api/openai/v1/chat/completions", {
        method: "POST",
        body,
      }),
    );
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      error: {
        code: "runtime_unavailable",
        message: expect.stringContaining("retired"),
        request_id: expect.any(String),
      },
    });
  });
});
