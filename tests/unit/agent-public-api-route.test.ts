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
    "Retired execution must not load a runtime allocator or database",
  );
});
vi.mock("@/lib/agents/public-api/auth", () => {
  throw new Error(
    "Retired execution must not authenticate into the old dispatch path",
  );
});
import {
  POST,
  OPTIONS,
} from "@/app/api/v1/agent-endpoints/[endpointId]/responses/route";
describe("retired public response admission", () => {
  it.each([
    "{}",
    "{",
    JSON.stringify({ input: "hello", stream: true, tools: [{}] }),
  ])("returns retirement before parsing input %s", async (body) => {
    const response = await POST(
      new Request("http://localhost/api/v1/agent-endpoints/old/responses", {
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
  it("does not advertise executable legacy CORS admission", async () => {
    const response = await OPTIONS(
      new Request("http://localhost/api/v1/agent-endpoints/old/responses", {
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(410);
    expect(response.headers.has("access-control-allow-methods")).toBe(false);
  });
});
