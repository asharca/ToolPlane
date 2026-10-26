// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { A2ATask } from "@prisma/client";
const mocks = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock("@/lib/a2a/principal", () => ({
  isLocalGrant: (grant: { kind?: string }) => grant.kind === "local",
  isRemoteGrant: (grant: { kind?: string }) => grant.kind === "remote",
  assertLiveGrant: mocks.live,
}));
import { executePublishedTask } from "@/lib/a2a/executor";
const row = {
  id: "task",
  grant: {
    kind: "published",
    workspaceId: "workspace",
    ownerKey: "owner",
    endpointId: "endpoint",
    clientId: "client",
  },
} as unknown as A2ATask;
beforeEach(() => vi.resetAllMocks());
describe("published execution rejection", () => {
  it("rejects a valid historical published task instead of completing it", async () => {
    await expect(
      executePublishedTask(row, new AbortController().signal),
    ).rejects.toThrow("does not support public endpoint execution");
    expect(mocks.live).toHaveBeenCalledWith(row.grant, "send");
  });
  it("retains live authorization before rejecting execution", async () => {
    mocks.live.mockRejectedValue(new Error("revoked"));
    await expect(
      executePublishedTask(row, new AbortController().signal),
    ).rejects.toThrow("revoked");
  });
  it.each(["local", "remote"])(
    "does not intercept %s collaboration",
    async (kind) => {
      await expect(
        executePublishedTask(
          { ...row, grant: { kind } } as unknown as A2ATask,
          new AbortController().signal,
        ),
      ).rejects.toThrow("requires a published target");
      expect(mocks.live).not.toHaveBeenCalled();
    },
  );
});
