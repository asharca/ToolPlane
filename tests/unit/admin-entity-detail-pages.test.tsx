import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  user: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
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
vi.mock("@/lib/admin/users", () => ({ getUserDetail: mocks.user }));
vi.mock("@/lib/admin/workspaces", () => ({
  getWorkspaceDetail: mocks.workspace,
}));
vi.mock("@/lib/admin/user-actions", () => ({
  setUserRoleAction: vi.fn(),
  setUserStatusAction: vi.fn(),
  deleteUserAction: vi.fn(),
}));
vi.mock("@/lib/admin/workspace-actions", () => ({
  deleteWorkspaceAdminAction: vi.fn(),
}));

import UserPage from "@/app/admin/users/[id]/page";
import WorkspacePage from "@/app/admin/workspaces/[id]/page";
const props = (returnTo?: string) => ({
  params: Promise.resolve({ id: "target-1" }),
  searchParams: Promise.resolve({ returnTo }),
});
const user = () => ({
  id: "target-1",
  email: "ada@example.com",
  name: "Ada",
  role: "user",
  status: "active",
  createdAt: new Date("2026-08-01"),
  ownedWorkspaces: [],
  memberships: [],
  _count: { apiTokens: 3 },
});
const workspace = () => ({
  id: "target-1",
  name: "Acme workspace",
  slug: "acme",
  status: "active",
  owner: { id: "owner-1", email: "owner@example.com" },
  createdAt: new Date("2026-08-01"),
  members: [],
  deployments: [],
  agents: [],
  sandboxes: [],
  recentErrors: [],
  _count: { toolkits: 2, installedSkills: 3, modelProviders: 4 },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin-1", timeZone: "UTC" });
  mocks.user.mockResolvedValue(user());
  mocks.workspace.mockResolvedValue(workspace());
});
afterEach(cleanup);

describe("admin user detail", () => {
  it("requires admin access before loading personal account data", async () => {
    mocks.admin.mockRejectedValue(new Error("Admin only"));
    await expect(UserPage(props())).rejects.toThrow("Admin only");
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("returns notFound for missing accounts", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(UserPage(props())).rejects.toThrow("notFound");
  });
  it("protects the signed-in admin from role, status and deletion controls", async () => {
    mocks.user.mockResolvedValue({ ...user(), id: "admin-1", role: "admin" });
    render(await UserPage(props()));
    expect(
      screen.getByText("youCanapostChangeYourOwnRoleOrStatus"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "demoteToUser" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "suspend" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "deleteUser" }),
    ).not.toBeInTheDocument();
  });
  it.each([
    ["admin", "suspended", "demoteToUser", "reactivate"],
    ["user", "active", "promoteToAdmin", "suspend"],
  ])(
    "offers appropriate access transitions for %s/%s",
    async (role, status, roleAction, statusAction) => {
      mocks.user.mockResolvedValue({ ...user(), role, status, name: null });
      render(await UserPage(props()));
      expect(
        screen.getByRole("heading", { name: "ada@example.com" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: roleAction }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: statusAction }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "deleteUser" }),
      ).toBeInTheDocument();
      expect(screen.getByText("tokenImpact:3")).toBeInTheDocument();
    },
  );
  it("excludes owned workspaces from joined memberships and totals destructive impact", async () => {
    mocks.user.mockResolvedValue({
      ...user(),
      ownedWorkspaces: [
        {
          id: "owned",
          name: "Owned workspace",
          slug: "owned",
          _count: { deployments: 2, agents: 3, sandboxes: 4 },
        },
        {
          id: "second",
          name: "Second workspace",
          slug: "second",
          _count: { deployments: 1, agents: 2, sandboxes: 3 },
        },
      ],
      memberships: [
        {
          workspace: { id: "owned", name: "Owned workspace", slug: "owned" },
          role: "owner",
        },
        ...["owner", "admin", "member"].map((role) => ({
          workspace: { id: role, name: `Joined ${role}`, slug: role },
          role,
        })),
      ],
    });
    render(await UserPage(props("/admin/users?q=ada")));
    expect(
      screen.getAllByRole("link", { name: /Owned workspace/ }),
    ).toHaveLength(1);
    expect(screen.getByText("workspaceRoleOwner")).toBeInTheDocument();
    expect(screen.getByText("workspaceRoleAdmin")).toBeInTheDocument();
    expect(screen.getByText("workspaceRoleMember")).toBeInTheDocument();
    expect(screen.getByText("impact:2,3,5,7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "users1" })).toHaveAttribute(
      "href",
      "/admin/users?q=ada",
    );
    const activity = new URL(
      screen.getByRole("link", { name: "activity" }).getAttribute("href") ?? "",
      "https://example.com",
    );
    expect(activity.searchParams.get("actorId")).toBe("target-1");
  });
});

describe("admin workspace detail", () => {
  it("requires admin access before loading workspace operations", async () => {
    mocks.admin.mockRejectedValue(new Error("Admin only"));
    await expect(WorkspacePage(props())).rejects.toThrow("Admin only");
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("returns notFound for absent workspaces", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(WorkspacePage(props())).rejects.toThrow("notFound");
  });
  it("shows safe empty operational state and explicit deletion impact", async () => {
    render(await WorkspacePage(props("https://evil.example")));
    expect(
      screen.getByRole("heading", { name: "Acme workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("noErrors")).toBeInTheDocument();
    expect(screen.getByText("impact:1,0,0,0")).toBeInTheDocument();
    expect(screen.getByText("workspaceImpact:0,2,3,4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "workspaces" })).toHaveAttribute(
      "href",
      "/admin/workspaces",
    );
    expect(
      screen.getByRole("button", { name: "deleteWorkspace" }),
    ).toBeInTheDocument();
  });
  it("links members, agents, sandboxes and errors to scoped administrator diagnostics", async () => {
    mocks.workspace.mockResolvedValue({
      ...workspace(),
      status: "suspended",
      members: ["owner", "admin", "member", "custom"].map((role) => ({
        role,
        user: { id: role, email: `${role}@example.com` },
      })),
      agents: [
        {
          id: "agent-1",
          name: "Research agent",
          runtimeKind: "hermes",
          model: null,
        },
      ],
      sandboxes: [
        {
          id: "sandbox-1",
          deploymentId: "dep-sandbox",
          name: "Sandbox one",
          kind: "docker",
          status: "error",
        },
      ],
      deployments: [
        "running",
        "failed",
        "error",
        "provisioning",
        "starting",
        "stopped",
      ].map((status, index) => ({
        id: `dep-${index}`,
        name: index === 0 ? "Search server" : null,
        source: index < 5 ? `source-${index}` : null,
        status,
      })),
      recentErrors: [
        {
          id: "event-1",
          message: "Runtime stopped unexpectedly",
          eventName: "sandbox.failed",
          outcome: "error",
          createdAt: new Date("2026-08-01"),
        },
      ],
    });
    render(await WorkspacePage(props()));
    expect(screen.getByText("deploymentStatusRunning")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dep-5" })).toHaveAttribute(
      "href",
      expect.stringContaining("deploymentId=dep-5"),
    );
    expect(
      screen.getByRole("link", { name: /Research agent/ }),
    ).toHaveAttribute("href", expect.stringContaining("agentId=agent-1"));
    expect(screen.getByRole("link", { name: /Sandbox one/ })).toHaveAttribute(
      "href",
      expect.stringContaining("deploymentId=dep-sandbox"),
    );
    expect(
      screen.getByRole("link", { name: /Runtime stopped unexpectedly/ }),
    ).toHaveAttribute("href", expect.stringContaining("/admin/logs/event-1?"));
    expect(screen.getByText("custom")).toBeInTheDocument();
    expect(screen.getByText("workspaceImpact:4,2,3,4")).toBeInTheDocument();
  });
});
