// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  userBefore: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  workspaces: vi.fn(),
  kill: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workspace: { findMany: mocks.workspaces },
  },
}));
vi.mock("@/lib/workspace/teardown", () => ({
  killWorkspaceProcesses: mocks.kill,
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: mocks.audit }));
import {
  deleteManagedUser,
  setUserRole,
  setUserStatus,
} from "@/lib/admin/users";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspaces.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
  mocks.transaction.mockImplementation(async (run) =>
    run({
      user: {
        findUniqueOrThrow: mocks.userBefore,
        update: mocks.userUpdate,
        delete: mocks.userDelete,
      },
    }),
  );
});

describe("managed user mutation audit boundaries", () => {
  it.each([
    () => setUserRole("same", "same", "user"),
    () => setUserStatus("same", "same", "suspended"),
    () => deleteManagedUser("same", "same"),
  ])("refuses self-modification before side effects", async (action) => {
    await expect(action()).rejects.toThrow("yourself");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.workspaces).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("stops every owned workspace before deleting the user", async () => {
    await deleteManagedUser("admin", "user");
    expect(mocks.kill.mock.calls).toEqual([["w1"], ["w2"]]);
    expect(mocks.kill.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.userDelete.mock.invocationCallOrder[0],
    );
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: "user" } });
    expect(mocks.audit.mock.calls.map((call) => call[1].action)).toEqual([
      "user.delete.requested",
      "user.deleted",
    ]);
  });
  it("never deletes the user when workspace teardown fails and audits the failure", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("busy runtime"));
    await expect(deleteManagedUser("admin", "user")).rejects.toThrow(
      "busy runtime",
    );
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(), {
      actorId: "admin",
      action: "user.delete.failed",
      targetType: "user",
      targetId: "user",
      outcome: "error",
    });
  });
  it("audits transactional deletion failure without hiding the cause", async () => {
    mocks.userDelete.mockRejectedValueOnce(new Error("constraint violation"));
    await expect(deleteManagedUser("admin", "user")).rejects.toThrow(
      "constraint violation",
    );
    expect(mocks.audit.mock.calls.map((call) => call[1].action)).toEqual([
      "user.delete.requested",
      "user.delete.failed",
    ]);
  });
});
