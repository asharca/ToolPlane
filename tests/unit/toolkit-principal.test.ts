// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
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
