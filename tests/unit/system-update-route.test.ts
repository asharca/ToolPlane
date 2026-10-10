// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isSameOriginRequest: vi.fn(),
  applySystemUpdate: vi.fn(),
  getLocalSystemUpdateStatus: vi.fn(),
  getSystemUpdateStatus: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/http/origin", () => ({
  isSameOriginRequest: mocks.isSameOriginRequest,
}));
vi.mock("@/lib/system/release-update", () => ({
  applySystemUpdate: mocks.applySystemUpdate,
  getLocalSystemUpdateStatus: mocks.getLocalSystemUpdateStatus,
  getSystemUpdateStatus: mocks.getSystemUpdateStatus,
}));

import { GET, POST } from "@/app/api/v1/admin/system/update/route";

describe("system update route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ role: "admin" });
  });

  it("rejects a cross-origin update before applying it", async () => {
    mocks.isSameOriginRequest.mockReturnValue(false);

    const response = await POST(
      new Request("https://toolplane.test/api/v1/admin/system/update", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.applySystemUpdate).not.toHaveBeenCalled();
  });

  it("lets an authenticated member check for updates", async () => {
    mocks.getCurrentUser.mockResolvedValue({ role: "user" });
    mocks.getSystemUpdateStatus.mockResolvedValue({ updateAvailable: false });

    const response = await GET(
      new Request("https://toolplane.test/api/v1/admin/system/update"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updateAvailable: false });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not disclose local runtime status without authentication", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(
      new Request("https://toolplane.test/api/v1/admin/system/update?local=1"),
    );
    expect(response.status).toBe(401);
    expect(mocks.getLocalSystemUpdateStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", false, 503],
    ["idle", true, 200],
    ["applying", false, 200],
    ["failed", false, 200],
  ] as const)(
    "gates local status %s with readiness %s using HTTP %s",
    async (status, runtimeReady, expectedStatus) => {
      mocks.getLocalSystemUpdateStatus.mockResolvedValue({
        runtimeId: "new-process",
        currentVersion: "new-version",
        runtimeReady,
        artifactName: "runtime.tar.gz",
        updateJob: { status, targetVersion: null, message: null },
      });
      const response = await GET(
        new Request(
          "https://toolplane.test/api/v1/admin/system/update?local=1",
        ),
      );
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("Retry-After")).toBe(
        expectedStatus === 503 ? "2" : null,
      );
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    },
  );
});
