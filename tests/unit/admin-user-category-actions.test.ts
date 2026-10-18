// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  status: vi.fn(),
  removeUser: vi.fn(),
  user: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user } } }));
vi.mock("@/lib/admin/users", () => ({
  setUserRole: mocks.role,
  setUserStatus: mocks.status,
  deleteManagedUser: mocks.removeUser,
}));
vi.mock("@/lib/admin/categories", () => ({
  createCategory: mocks.create,
  updateCategory: mocks.update,
  deleteCategory: mocks.remove,
}));
import {
  deleteUserAction,
  setUserRoleAction,
  setUserStatusAction,
} from "@/lib/admin/user-actions";
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
} from "@/lib/admin/category-actions";

function form(values: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin" });
});

describe("admin user mutation boundaries", () => {
  it.each([
    [setUserRoleAction, mocks.role, "role", "admin"],
    [setUserStatusAction, mocks.status, "status", "suspended"],
  ] as const)(
    "validates and applies a user mutation",
    async (action, mutation, field, value) => {
      expect(await action({}, form({ userId: "u", [field]: "root" }))).toEqual({
        error: "errorActionFailed",
      });
      expect(mutation).not.toHaveBeenCalled();
      expect(await action({}, form({ userId: "u", [field]: value }))).toEqual({
        ok: true,
      });
      expect(mutation).toHaveBeenCalledWith("admin", "u", value);
      expect(mocks.revalidate.mock.calls).toEqual([
        ["/admin/users"],
        ["/admin/users/u"],
      ]);
    },
  );
  it.each([
    [setUserRoleAction, mocks.role, "role", "user"],
    [setUserStatusAction, mocks.status, "status", "active"],
  ] as const)(
    "distinguishes self-protection from unexpected failures",
    async (action, mutation, field, value) => {
      const data = form({ userId: "admin", [field]: value });
      mutation.mockRejectedValueOnce(new Error("Cannot change yourself"));
      expect(await action({}, data)).toEqual({
        error: "errorCannotChangeSelf",
      });
      mutation.mockRejectedValueOnce("database unavailable");
      expect(await action({}, data)).toEqual({ error: "errorActionFailed" });
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );
  it("requires the stored email, then protects self-deletion and handles failure", async () => {
    const data = form({ userId: "u", confirm: "real@example.com" });
    mocks.user.mockResolvedValueOnce(null);
    expect(await deleteUserAction({}, data)).toEqual({
      error: "errorTypeEmail",
    });
    mocks.user.mockResolvedValue({ email: "real@example.com" });
    mocks.removeUser.mockRejectedValueOnce(new Error("Cannot delete yourself"));
    expect(await deleteUserAction({}, data)).toEqual({
      error: "errorCannotChangeSelf",
    });
    mocks.removeUser.mockRejectedValueOnce(new Error("storage failed"));
    expect(await deleteUserAction({}, data)).toEqual({
      error: "errorActionFailed",
    });
    expect(await deleteUserAction({}, data)).toBeUndefined();
    expect(mocks.removeUser).toHaveBeenLastCalledWith("admin", "u");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/users");
  });
});

describe("admin category mutations", () => {
  it.each([
    { name: "", slug: "valid" },
    { name: "Tools", slug: "bad_slug" },
    {},
  ])("rejects invalid categories before writing", async (values) => {
    expect(await createCategoryAction({}, form(values))).toEqual({
      error: "errorInvalidCategory",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("normalizes creation, maps conflicts, and refreshes public category surfaces", async () => {
    const data = form({ name: "  Tools  ", slug: "  MCP-TOOLS  " });
    mocks.create.mockRejectedValueOnce(new Error("duplicate"));
    expect(await createCategoryAction({}, data)).toEqual({
      error: "errorCategoryExists",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(await createCategoryAction({}, data)).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenLastCalledWith(
      "mcp-tools",
      "Tools",
      "admin",
    );
    expect(mocks.revalidate.mock.calls).toEqual([
      ["/admin/categories"],
      ["/categories"],
      ["/categories/[slug]", "page"],
      ["/app/[workspace]/market", "layout"],
    ]);
  });
  it("requires an id and name and bounds updated category names", async () => {
    expect(await updateCategoryAction({}, new FormData())).toEqual({
      error: "errorInvalidCategoryName",
    });
    const data = form({ categoryId: " c ", name: `  ${"x".repeat(140)}  ` });
    mocks.update.mockRejectedValueOnce(new Error("missing"));
    expect(await updateCategoryAction({}, data)).toEqual({
      error: "errorActionFailed",
    });
    expect(await updateCategoryAction({}, data)).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenLastCalledWith(
      "c",
      "x".repeat(120),
      "admin",
    );
  });
  it.each([
    [new Error("Category is not empty"), "errorCategoryNotEmpty"],
    [new Error("missing"), "errorActionFailed"],
    [null, "errorActionFailed"],
  ])("keeps referenced categories intact", async (error, key) => {
    mocks.remove.mockRejectedValueOnce(error);
    expect(await deleteCategoryAction({}, form({ categoryId: "c" }))).toEqual({
      error: key,
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("removes an empty category and denies unauthorized edits before writes", async () => {
    expect(await deleteCategoryAction({}, form({ categoryId: "c" }))).toEqual({
      ok: true,
    });
    expect(mocks.remove).toHaveBeenCalledWith("c", "admin");
    mocks.auth.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(
      createCategoryAction({}, form({ name: "Tools", slug: "tools" })),
    ).rejects.toThrow("Forbidden");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
