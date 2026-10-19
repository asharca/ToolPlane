import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  WorkspaceAccountPage,
  type WorkspaceAccountUser,
} from "@/components/dashboard/WorkspaceAccountPage";
import type { listWorkspacesForUser } from "@/lib/workspace/queries";
import messages from "../../messages/en.json";

const mocks = vi.hoisted(() => ({
  list: vi.fn<typeof listWorkspacesForUser>(),
  current: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookie }),
}));
vi.mock("next-intl/server", () => ({
  getMessages: async () => messages,
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      `${key}${values?.name ? ` ${values.name}` : ""}`,
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getDefaultWorkspace: mocks.current,
  listWorkspacesForUser: mocks.list,
}));
vi.mock("@/components/dashboard/AccountMenu", () => ({
  AccountMenu: () => null,
}));
vi.mock("@/components/dashboard/DashboardLogo", () => ({
  DashboardLogo: () => null,
}));
vi.mock("@/components/dashboard/PersonalSettingsContent", () => ({
  PersonalSettingsContent: () => <div>Personal settings</div>,
}));
vi.mock("@/components/notifications/NotificationBell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/components/notifications/NotificationInbox", () => ({
  NotificationInbox: () => <div>Notification inbox</div>,
}));
vi.mock("@/components/dashboard/WorkspaceForms", () => ({
  CreateWorkspaceForm: () => <button type="button">Create workspace</button>,
  WorkspaceDeleteForm: () => <button type="button">Retry cleanup</button>,
  WorkspaceMemberAction: () => <button type="button">Leave workspace</button>,
}));
vi.mock("@/components/dashboard/DashboardUI", () => ({
  DashboardPanel: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("@/components/timezone/UserTimeZoneProvider", () => ({
  UserTimeZoneProvider: ({ children }: { children: ReactNode }) => children,
}));
const user: WorkspaceAccountUser = {
  id: "user",
  name: "Member",
  email: "member@example.test",
  role: "user",
  status: "active",
  createdAt: new Date("2026-01-01"),
  detectedTimeZone: null,
  timeZoneOverride: null,
};
afterEach(() => vi.resetAllMocks());

describe("account workspace navigation and recovery permissions", () => {
  it("offers active workspaces while limiting cleanup recovery to owners", async () => {
    mocks.current.mockResolvedValue({ id: "active-owner", slug: "owned" });
    mocks.list.mockResolvedValue([
      {
        id: "active-owner",
        name: "Owned",
        slug: "owned",
        status: "active",
        role: "owner",
        memberCount: 2,
      },
      {
        id: "active-member",
        name: "Joined",
        slug: "joined",
        status: "active",
        role: "member",
        memberCount: 3,
      },
      {
        id: "failed-owner",
        name: "Failed",
        slug: "failed",
        status: "delete_failed",
        role: "owner",
        memberCount: 1,
      },
      {
        id: "deleting-member",
        name: "Deleting",
        slug: "deleting",
        status: "deleting",
        role: "admin",
        memberCount: 4,
      },
    ]);
    const { container } = render(
      await WorkspaceAccountPage({ user, notice: "deleted" }),
    );
    expect(
      screen.getByRole("link", { name: "enterNamed Owned" }),
    ).toHaveAttribute("href", "/app/owned/chat");
    expect(
      screen.getByRole("link", { name: "enterNamed Joined" }),
    ).toHaveAttribute("href", "/app/joined/chat");
    const articles = container.querySelectorAll("article");
    expect(articles).toHaveLength(4);
    expect(within(articles.item(0)).queryByText("Leave workspace")).toBeNull();
    expect(within(articles.item(1)).getByText("Leave workspace")).toBeVisible();
    expect(within(articles.item(2)).getByText("Retry cleanup")).toBeVisible();
    expect(within(articles.item(3)).getByText("Leave workspace")).toBeVisible();
    expect(within(articles.item(3)).queryByRole("link")).toBeNull();
    expect(screen.getByText("notice.deleted")).toBeVisible();
  });

  it("preserves install intent when choosing an available workspace", async () => {
    mocks.current.mockResolvedValue(null);
    mocks.list.mockResolvedValue([
      {
        id: "workspace",
        name: "Research",
        slug: "research team",
        status: "active",
        role: "admin",
        memberCount: 1,
      },
    ]);
    render(
      await WorkspaceAccountPage({
        user: { ...user, name: null, role: "admin" },
        intent: "/app?install=package",
        notice: "ignored",
      }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "chooseWorkspace",
    );
    expect(
      screen.getByRole("link", { name: "enterNamed Research" }),
    ).toHaveAttribute("href", "/app?install=package&workspace=research%20team");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("provides creation when no workspace is available", async () => {
    mocks.current.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
    render(await WorkspaceAccountPage({ user }));
    expect(screen.getByText("emptyTitle")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create workspace" }),
    ).toBeVisible();
  });

  it.each(["account", "notifications"] as const)(
    "does not load workspace membership for the %s view",
    async (view) => {
      mocks.current.mockResolvedValue(null);
      render(
        await WorkspaceAccountPage({
          user,
          view,
          notificationPage: 2,
          unreadOnly: true,
        }),
      );
      expect(
        screen.getByText(
          view === "account" ? "Personal settings" : "Notification inbox",
        ),
      ).toBeVisible();
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
});
