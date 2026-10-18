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
  categories: vi.fn(),
  categoryFind: vi.fn(),
  categoryBefore: vi.fn(),
  categoryCreate: vi.fn(),
  categoryUpdate: vi.fn(),
  categoryDelete: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    workspace: { findMany: mocks.workspaces },
    category: { findMany: mocks.categories },
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
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "@/lib/admin/categories";
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
      category: {
        findUnique: mocks.categoryFind,
        findUniqueOrThrow: mocks.categoryBefore,
        create: mocks.categoryCreate,
        update: mocks.categoryUpdate,
        delete: mocks.categoryDelete,
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
  it("records role and suspension before/after state in the mutation transaction", async () => {
    mocks.userBefore
      .mockResolvedValueOnce({ role: "user" })
      .mockResolvedValueOnce({ status: "active" });
    await setUserRole("admin", "user", "admin");
    await setUserStatus("admin", "user", "suspended");
    expect(mocks.userUpdate.mock.calls).toEqual([
      [{ where: { id: "user" }, data: { role: "admin" } }],
      [{ where: { id: "user" }, data: { status: "suspended" } }],
    ]);
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.anything(), {
      actorId: "admin",
      action: "user.role.changed",
      targetType: "user",
      targetId: "user",
      changes: { before: { role: "user" }, after: { role: "admin" } },
    });
    expect(mocks.audit).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        action: "user.status.changed",
        changes: {
          before: { status: "active" },
          after: { status: "suspended" },
        },
      }),
    );
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

describe("category service consumer counts and deletion protection", () => {
  const counts = {
    servers: 0,
    skills: 0,
    clients: 0,
    agentListings: 0,
    marketListings: 0,
    toolkits: 0,
  };
  it("counts standalone skill releases without double-counting catalog-backed skills", async () => {
    mocks.categories.mockResolvedValue([
      {
        id: "c",
        slug: "tools",
        name: "Tools",
        _count: {
          ...counts,
          skills: 2,
          servers: 3,
          clients: 4,
          agentListings: 5,
          toolkits: 6,
        },
        marketListings: [
          { kind: "skill", sourceSkillId: "catalog" },
          { kind: "skill", sourceSkillId: null },
          { kind: "assistant", sourceSkillId: null },
          { kind: "mcp", sourceSkillId: null },
        ],
      },
    ]);
    expect(await listCategories()).toEqual([
      {
        id: "c",
        slug: "tools",
        name: "Tools",
        _count: {
          skills: 3,
          servers: 3,
          clients: 4,
          agentListings: 5,
          assistants: 1,
          toolkits: 6,
        },
      },
    ]);
  });
  it("audits creation and renaming with the prior name", async () => {
    mocks.categoryCreate.mockResolvedValue({
      id: "c",
      name: "Tools",
      slug: "tools",
    });
    expect(await createCategory("tools", "Tools")).toEqual({
      id: "c",
      name: "Tools",
      slug: "tools",
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(), {
      actorId: "system",
      action: "category.created",
      targetType: "category",
      targetId: "c",
      changes: { slug: "tools", name: "Tools" },
    });
    mocks.categoryBefore.mockResolvedValue({ name: "Tools" });
    mocks.categoryUpdate.mockResolvedValue({ id: "c", name: "New" });
    expect(await updateCategory("c", "New", "admin")).toEqual({
      id: "c",
      name: "New",
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "admin",
        action: "category.updated",
        changes: { before: { name: "Tools" }, after: { name: "New" } },
      }),
    );
  });
  it.each(Object.keys(counts))(
    "refuses deletion while %s references remain",
    async (relation) => {
      mocks.categoryFind.mockResolvedValue({
        _count: { ...counts, [relation]: 1 },
      });
      await expect(deleteCategory("c", "admin")).rejects.toThrow("not empty");
      expect(mocks.categoryDelete).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("distinguishes missing categories and deletes only an empty category", async () => {
    mocks.categoryFind
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _count: counts });
    await expect(deleteCategory("c")).rejects.toThrow("not found");
    await deleteCategory("c", "admin");
    expect(mocks.categoryDelete).toHaveBeenCalledWith({ where: { id: "c" } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
      actorId: "admin",
      action: "category.deleted",
      targetType: "category",
      targetId: "c",
    });
  });
});
