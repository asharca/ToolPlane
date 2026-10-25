// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import {
  GET,
  HEAD,
  POST,
  PUT,
  PATCH,
  DELETE,
  OPTIONS,
} from "@/app/api/v1/agent-runtimes/[runtimeId]/dashboard/[accessToken]/[[...path]]/route";
const handlers = { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS };
describe("retired Hermes executable dashboard", () => {
  it.each(Object.entries(handlers))(
    "returns 410 for %s instead of starting or redirecting to a broker",
    async (method, handler) => {
      const response = await handler(
        new Request("http://toolplane.test/dashboard", { method }),
      );
      expect(response.status).toBe(410);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({
        error:
          "Legacy Agent dashboards are retired. Historical files remain available through the read-only session workspace.",
      });
    },
  );
});
