// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/auth/tokens", () => ({ verifyApiTokenContext: mocks.context }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.session }));
import {
  resolveRequestPrincipal,
  resolveRequestUser,
  resolveAgentControlRequestUser,
} from "@/lib/auth/request-user";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: "user" });
});
const req = (authorization?: string) =>
  new Request("https://toolplane.test", {
    headers: authorization === undefined ? {} : { authorization },
  });
describe("credential scope is never reduced to user identity", () => {
  it("retains the Toolkit identity only for explicit scoped callers", async () => {
    mocks.context.mockResolvedValue({
      user: { id: "user" },
      token: { id: "token", toolkitId: "a" },
    });
    const principal = await resolveRequestPrincipal(req("Bearer install"));
    expect(principal).toMatchObject({
      credential: "toolkit-token",
      token: { toolkitId: "a" },
    });
    expect(await resolveRequestUser(req("Bearer install"))).toBeNull();
    expect(
      await resolveAgentControlRequestUser(req("Bearer install")),
    ).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
  });
});

describe("session cookies authenticate unsafe methods only from the app origin", () => {
  const mutation = (headers: Record<string, string>) =>
    new Request("https://toolplane.test/api/v1/work-sessions", {
      method: "POST",
      headers,
    });
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://toolplane.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects foreign, null and missing origins before reading the session", async () => {
    for (const headers of Array.of<Record<string, string>>(
      { origin: "https://sibling.toolplane.test", host: "toolplane.test" },
      { origin: "null" },
      {},
    ))
      expect(await resolveRequestUser(mutation(headers))).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("accepts same-origin mutations, safe reads and bearer clients", async () => {
    expect(
      await resolveRequestUser(mutation({ origin: "https://toolplane.test" })),
    ).toEqual({ id: "user" });
    expect(
      await resolveRequestUser(
        mutation({ origin: "http://10.0.0.5:10030", host: "10.0.0.5:10030" }),
      ),
    ).toEqual({ id: "user" });
    expect(await resolveRequestUser(req())).toEqual({ id: "user" });
    mocks.context.mockResolvedValue({
      user: { id: "user" },
      token: { id: "token", toolkitId: null },
    });
    expect(
      await resolveRequestUser(
        mutation({
          authorization: "Bearer personal",
          origin: "https://x.test",
        }),
      ),
    ).toEqual({ id: "user" });
  });
});
