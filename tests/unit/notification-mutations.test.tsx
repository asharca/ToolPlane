import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationInboxActions } from "@/components/notifications/NotificationInboxActions";
import { NotificationPublishForm } from "@/components/notifications/NotificationPublishForm";
import type { NotificationActionState } from "@/lib/notifications/actions";

const actions = vi.hoisted(() => ({
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  accept: vi.fn(),
  publishSite: vi.fn(),
  publishWorkspace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/notifications/actions", () => ({
  markNotificationReadAction: actions.markRead,
  markAllNotificationsReadAction: actions.markAllRead,
  publishSiteNotificationAction: actions.publishSite,
  publishWorkspaceNotificationAction: actions.publishWorkspace,
}));
vi.mock("@/lib/workspace/management-actions", () => ({
  acceptWorkspaceInvitationNotificationAction: actions.accept,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: actions.refresh }),
}));

afterEach(() => {
  vi.resetAllMocks();
});

async function submit() {
  const form = document.querySelector("form");
  if (!form) throw new Error("Expected form");
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe("notification mutation state", () => {
  it.each([undefined, "notice-1"])(
    "marks %s read and broadcasts unread-count refresh only after success",
    async (notificationId) => {
      const changed = vi.fn();
      window.addEventListener("toolplane:notifications-changed", changed);
      try {
        const mark = notificationId ? actions.markRead : actions.markAllRead;
        mark
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValueOnce({ ok: true });
        render(
          <NotificationInboxActions notificationId={notificationId} unread />,
        );
        await submit();
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The operation failed. Please try again.",
        );
        expect(changed).not.toHaveBeenCalled();
        expect(actions.refresh).not.toHaveBeenCalled();
        await submit();
        expect(changed).toHaveBeenCalledOnce();
        expect(actions.refresh).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        const data = mark.mock.calls[1][1] as FormData;
        expect(data.get("notificationId")).toBe(notificationId ?? null);
      } finally {
        window.removeEventListener("toolplane:notifications-changed", changed);
      }
    },
  );

  it("refreshes manually without a mark-read form when everything is already read", async () => {
    const changed = vi.fn();
    window.addEventListener("toolplane:notifications-changed", changed);
    try {
      render(<NotificationInboxActions />);
      expect(
        screen.queryByRole("button", { name: "Mark all as read" }),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(actions.refresh).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
      expect(actions.markAllRead).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("toolplane:notifications-changed", changed);
    }
  });

  it("keeps invitation failures visible and sends the notification ID", async () => {
    actions.accept.mockResolvedValue({ error: "Invitation expired" });
    render(
      <NotificationInboxActions
        notificationId="invite-1"
        canAcceptInvitation
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Refresh" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Accept and join workspace" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invitation expired",
    );
    expect(
      (actions.accept.mock.calls[0][1] as FormData).get("notificationId"),
    ).toBe("invite-1");
    expect(
      screen.getByRole("button", { name: "Accept and join workspace" }),
    ).toBeEnabled();
  });

  it("disables read controls for the pending mutation", async () => {
    let finish!: (state: NotificationActionState) => void;
    actions.markRead.mockImplementation(
      () =>
        new Promise<NotificationActionState>((resolve) => {
          finish = resolve;
        }),
    );
    render(<NotificationInboxActions notificationId="notice-1" unread />);
    await submit();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    await act(async () => {
      finish({ error: "Try again" });
    });
    expect(screen.getByRole("button", { name: "Mark as read" })).toBeEnabled();
  });
});

describe("workspace notification drafts", () => {
  it("clears selected addresses when switching to all members and resets the audience after success", async () => {
    const user = userEvent.setup();
    actions.publishWorkspace
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, recipientCount: 0 });
    render(<NotificationPublishForm workspaceSlug="team" />);
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Update");
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Workspace maintenance",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Recipient emails" }),
      "member@example.com",
    );
    await user.click(screen.getByRole("combobox", { name: "Audience" }));
    await user.click(
      await screen.findByRole("option", {
        name: "All active members of this workspace",
      }),
    );
    expect(
      screen.queryByRole("textbox", { name: "Recipient emails" }),
    ).not.toBeInTheDocument();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The operation failed. Please try again.",
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Update",
    );
    expect(
      Object.fromEntries(actions.publishWorkspace.mock.calls[0][1] as FormData),
    ).toEqual({
      workspace: "team",
      title: "Update",
      body: "Workspace maintenance",
      audience: "all",
    });
    await submit();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Notification sent to 0 recipients.",
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(
      screen.getByRole("textbox", { name: "Recipient emails" }),
    ).toHaveValue("");
    expect(actions.publishSite).not.toHaveBeenCalled();
  });

  it("disables a draft while publication is pending and does not invent a delivery count", async () => {
    let finish!: (state: NotificationActionState) => void;
    actions.publishSite.mockImplementation(
      () =>
        new Promise<NotificationActionState>((resolve) => {
          finish = resolve;
        }),
    );
    render(<NotificationPublishForm />);
    await submit();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    await act(async () => {
      finish({ ok: true });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish notification" }),
    ).toBeEnabled();
  });
});
