import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  users: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(",")}` : key,
      { has: () => false },
    ),
}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/admin/users", () => ({ listUsers: mocks.users }));
vi.mock("@/lib/admin/workspaces", () => ({ listWorkspaces: mocks.workspaces }));

import UsersPage from "@/app/admin/users/page";
import WorkspacesPage from "@/app/admin/workspaces/page";
const empty = { items: [], total: 0, page: 1, pageSize: 20 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin-1", timeZone: "UTC" });
  mocks.users.mockResolvedValue(empty);
  mocks.workspaces.mockResolvedValue(empty);
});
afterEach(cleanup);

describe("admin list access, canonical navigation and state", () => {
  it.each([
    [UsersPage, mocks.users],
    [WorkspacesPage, mocks.workspaces],
  ])(
    "blocks private listings when administrator authorization fails",
    async (page, query) => {
      mocks.admin.mockRejectedValue(new Error("Admin required"));
      await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
        "Admin required",
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["", "emptyUsersDescription"],
    ["ada", "noUsersDescription"],
  ])(
    "explains account search emptiness for query %s",
    async (q, description) => {
      render(await UsersPage({ searchParams: Promise.resolve({ q }) }));
      expect(screen.getByText("noUsers")).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    },
  );
  it.each([
    ["", "emptyWorkspacesDescription"],
    ["acme", "noWorkspacesDescription"],
  ])(
    "explains workspace search emptiness for query %s",
    async (q, description) => {
      render(await WorkspacesPage({ searchParams: Promise.resolve({ q }) }));
      expect(screen.getByText("noWorkspaces")).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    },
  );
  it("canonicalizes whitespace and invalid pages without losing valid user filters", async () => {
    await expect(
      UsersPage({
        searchParams: Promise.resolve({
          q: " ada ",
          page: "NaN",
          role: "admin",
          status: "suspended",
        }),
      }),
    ).rejects.toThrow(
      "redirect:/admin/users?page=1&q=ada&role=admin&status=suspended",
    );
    expect(mocks.users).toHaveBeenCalledWith({
      page: 1,
      q: "ada",
      role: "admin",
      status: "suspended",
    });
  });
  it("normalizes invalid user filters to the all-users view", async () => {
    render(
      await UsersPage({
        searchParams: Promise.resolve({ role: "owner", status: "invalid" }),
      }),
    );
    expect(mocks.users).toHaveBeenCalledWith({
      page: 1,
      q: "",
      role: "",
      status: "",
    });
    expect(screen.getByText("noUsers")).toBeInTheDocument();
  });
  it("redirects out-of-range account pages to the final available page", async () => {
    mocks.users.mockResolvedValue({ ...empty, page: 99, total: 21 });
    await expect(
      UsersPage({ searchParams: Promise.resolve({ page: "99", q: "ada" }) }),
    ).rejects.toThrow("redirect:/admin/users?page=2&q=ada");
  });
  it("canonicalizes workspace searches while preserving owner and lifecycle filters", async () => {
    await expect(
      WorkspacesPage({
        searchParams: Promise.resolve({
          q: " acme ",
          owner: " ada@example.com ",
          status: "delete_failed",
          page: "-1",
        }),
      }),
    ).rejects.toThrow(
      "redirect:/admin/workspaces?page=1&q=acme&owner=ada%40example.com&status=delete_failed",
    );
    expect(mocks.workspaces).toHaveBeenCalledWith({
      page: 1,
      q: "acme",
      owner: "ada@example.com",
      status: "delete_failed",
    });
  });
  it("clamps workspace pages to the available result set", async () => {
    mocks.workspaces.mockResolvedValue({ ...empty, page: 12, total: 25 });
    await expect(
      WorkspacesPage({ searchParams: Promise.resolve({ page: "12" }) }),
    ).rejects.toThrow("redirect:/admin/workspaces?page=2");
  });
  it("shows user identity fallbacks, roles and pagination with preserved search filters", async () => {
    mocks.users.mockResolvedValue({
      items: [
        {
          id: "user-1",
          name: "Ada",
          email: "ada@example.com",
          role: "admin",
          status: "active",
          createdAt: new Date("2026-08-01"),
          _count: { ownedWorkspaces: 1, memberships: 2, apiTokens: 3 },
        },
        {
          id: "user-2",
          name: null,
          email: "bob@example.com",
          role: "user",
          status: "suspended",
          createdAt: new Date("2026-08-02"),
          _count: { ownedWorkspaces: 0, memberships: 1, apiTokens: 0 },
        },
      ],
      total: 25,
      page: 1,
      pageSize: 20,
    });
    await act(async () => {
      render(
        await UsersPage({
          searchParams: Promise.resolve({
            q: "example",
            role: "user",
            status: "active",
          }),
        }),
      );
    });
    expect(
      screen.getByRole("region", { name: "usersTableLabel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ada" })).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/users/user-1?returnTo="),
    );
    expect(
      screen.getByRole("link", { name: "bob@example.com" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /next/ })).toHaveAttribute(
      "href",
      "/admin/users?page=2&q=example&role=user&status=active",
    );
  });
  it("shows workspace lifecycle states, owners and pagination without dropping filters", async () => {
    mocks.workspaces.mockResolvedValue({
      items: ["active", "deleting", "delete_failed"].map((status, index) => ({
        id: `ws-${index}`,
        name: `Workspace ${index}`,
        slug: `workspace-${index}`,
        status,
        owner: { id: `owner-${index}`, email: `owner-${index}@example.com` },
        createdAt: new Date("2026-08-01"),
        _count: { members: 1, agents: 2, deployments: 3 },
      })),
      total: 25,
      page: 1,
      pageSize: 20,
    });
    await act(async () => {
      render(
        await WorkspacesPage({
          searchParams: Promise.resolve({
            q: "workspace",
            owner: "owner",
            status: "active",
          }),
        }),
      );
    });
    expect(
      screen.getByRole("region", { name: "workspacesTableLabel" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "owner-0@example.com" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/users/owner-0?returnTo="),
    );
    expect(screen.getByRole("link", { name: /next/ })).toHaveAttribute(
      "href",
      "/admin/workspaces?page=2&q=workspace&owner=owner&status=active",
    );
  });
});
