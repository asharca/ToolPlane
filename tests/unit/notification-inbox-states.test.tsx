import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import messages from "../../messages/en.json";

const actions = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  markAll: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("@/lib/notifications/service", () => ({
  listNotifications: actions.list,
}));
vi.mock("@/lib/notifications/actions", () => ({
  markNotificationReadAction: actions.markRead,
  markAllNotificationsReadAction: actions.markAll,
}));
vi.mock("@/lib/workspace/management-actions", () => ({
  acceptWorkspaceInvitationNotificationAction: actions.accept,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (current, part) => (current as Record<string, unknown>)[part],
          messages.console.notifications,
        );
      return String(value).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name]),
      );
    },
}));
beforeEach(() => vi.clearAllMocks());

function invitation(
  id: string,
  workspaceName: string | null,
  canAcceptInvitation: boolean,
) {
  return {
    id,
    kind: "workspace_invitation",
    title: "Untrusted stored title",
    body: "Untrusted stored body",
    workspaceName,
    canAcceptInvitation,
    createdAt: new Date("2026-10-08T12:00:00Z"),
    readAt: canAcceptInvitation ? null : new Date("2026-10-08T13:00:00Z"),
  };
}

describe("notification inbox invitation states", () => {
  it("uses trusted invitation text and hides acceptance for expired or unavailable workspaces", async () => {
    actions.list.mockResolvedValue({
      items: [
        invitation("active", "Engineering", true),
        invitation("expired", null, false),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      unreadCount: 1,
    });
    const { container } = render(
      await NotificationInbox({ userId: "user", timeZone: "UTC" }),
    );
    expect(
      screen.getByRole("heading", { name: "Invitation to Engineering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Invitation to Unavailable workspace",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Workspace: Engineering")).toBeInTheDocument();
    expect(
      screen.queryByText("Untrusted stored title"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Untrusted stored body")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Accept and join workspace" }),
    ).toHaveLength(1);
    expect(
      screen.getByText(
        "This invitation has been processed or is no longer valid.",
      ),
    ).toBeInTheDocument();
    const expired = screen
      .getByRole("heading", { name: "Invitation to Unavailable workspace" })
      .closest("li");
    if (!expired) throw new Error("Missing expired invitation");
    expect(within(expired).getByText("Read")).toBeInTheDocument();
    expect(
      within(expired).queryByRole("button", { name: "Mark as read" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-10-08T12:00:00.000Z",
    );
  });

  it.each([false, true])(
    "shows a filtered empty state and preserves existing query parameters (unread=%s)",
    async (unreadOnly) => {
      actions.list.mockResolvedValue({
        items: [],
        total: 41,
        page: 2,
        pageSize: 20,
        unreadCount: 0,
      });
      render(
        await NotificationInbox({
          userId: "user",
          timeZone: "UTC",
          unreadOnly,
          baseHref: "/app?view=notifications",
        }),
      );
      expect(
        screen.getByText(
          unreadOnly
            ? "You have no unread notifications."
            : "You have no notifications yet.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
        "href",
        `/app?view=notifications${unreadOnly ? "&unread=1" : ""}&page=1`,
      );
      expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
        "href",
        `/app?view=notifications${unreadOnly ? "&unread=1" : ""}&page=3`,
      );
      expect(
        screen.queryByRole("button", { name: "Mark all as read" }),
      ).not.toBeInTheDocument();
    },
  );
});
