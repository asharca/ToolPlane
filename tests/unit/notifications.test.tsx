import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInviteForm } from "@/components/dashboard/WorkspaceInviteForm";
import type { WorkspaceInvitePreviewState } from "@/lib/workspace/management-actions";
import { NotificationPublishForm } from "@/components/notifications/NotificationPublishForm";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import type { NotificationPage } from "@/lib/notifications/service";
import messages from "../../messages/en.json";

const actions = vi.hoisted(() => ({
  preview: vi.fn(),
  invite: vi.fn(),
  accept: vi.fn(),
  publishSite: vi.fn(),
  publishWorkspace: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/workspace/management-actions", () => ({
  previewWorkspaceInviteRecipientAction: actions.preview,
  inviteWorkspaceMemberAction: actions.invite,
  acceptWorkspaceInvitationNotificationAction: actions.accept,
}));
vi.mock("@/lib/notifications/actions", () => ({
  publishSiteNotificationAction: actions.publishSite,
  publishWorkspaceNotificationAction: actions.publishWorkspace,
  markNotificationReadAction: actions.markRead,
  markAllNotificationsReadAction: actions.markAllRead,
}));
vi.mock("@/lib/notifications/service", () => ({
  listNotifications: actions.list,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: actions.refresh }),
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async (namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      const text = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (value, segment) => (value as Record<string, unknown>)[segment],
          messages,
        ) as string;
      return text.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? `{${name}}`),
      );
    },
}));

const recipient = {
  id: "recipient-1",
  name: "Recipient One",
  email: "one@example.test",
};
const confirmLabel = "Invite this account and send an in-app notification";
function deferredPreview() {
  let resolve!: (value: WorkspaceInvitePreviewState) => void;
  const promise = new Promise<WorkspaceInvitePreviewState>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function enterEmail(email: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Recipient email" }), {
    target: { value: email },
  });
}
async function previewEmail(email: string) {
  enterEmail(email);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Preview recipient" }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Invitation recipient confirmation", () => {
  it("requires explicit account confirmation, sends its ID, and clears confirmation after success", async () => {
    actions.preview.mockResolvedValue({ email: recipient.email, recipient });
    actions.invite.mockResolvedValue({ invitePath: "/app/invitation#token" });
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail("ONE@example.test");
    expect(screen.getByText(recipient.name)).toBeInTheDocument();
    expect(
      screen.getByText(
        "This email is not verified. Confirm that this is the account you intend to invite.",
      ),
    ).toBeInTheDocument();
    expect(actions.invite).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
    });
    const form = actions.invite.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(form)).toEqual({
      workspace: "team",
      email: recipient.email,
      recipientId: recipient.id,
    });
    expect(
      screen.queryByRole("button", { name: confirmLabel }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview recipient" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Invitation link" }),
    ).toHaveValue(`${window.location.origin}/app/invitation#token`);
  });

  it("creates a link only after an explicit successful null-recipient preview", async () => {
    actions.preview.mockResolvedValue({
      email: "new@example.test",
      recipient: null,
    });
    actions.invite.mockResolvedValue({ error: "Creation failed" });
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail("new@example.test");
    expect(
      screen.getByText(
        "Not registered yet. Only an invitation link will be created.",
      ),
    ).toBeInTheDocument();
    expect(actions.invite).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create invitation link" }),
      );
    });
    expect(
      (actions.invite.mock.calls[0][1] as FormData).get("recipientId"),
    ).toBe("");
    expect(screen.getByRole("alert")).toHaveTextContent("Creation failed");
    expect(
      screen.getByRole("textbox", { name: "Recipient email" }),
    ).toHaveValue("new@example.test");
  });

  it("invalidates an existing candidate immediately when the email is edited", async () => {
    actions.preview.mockResolvedValue({ email: recipient.email, recipient });
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail(recipient.email);
    enterEmail("two@example.test");
    expect(screen.queryByText(recipient.name)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: confirmLabel }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview recipient" }),
    ).toBeInTheDocument();
  });

  it("discards a preview response arriving after an email edit", async () => {
    const old = deferredPreview();
    actions.preview.mockReturnValue(old.promise);
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail(recipient.email);
    enterEmail("two@example.test");
    await act(async () => {
      old.resolve({ email: recipient.email, recipient });
    });
    expect(
      screen.queryByRole("button", { name: confirmLabel }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create invitation link" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview recipient" }),
    ).toBeEnabled();
  });

  it("discards an older request even after editing back to the same normalized email", async () => {
    const old = deferredPreview();
    const latest = deferredPreview();
    actions.preview
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail(recipient.email);
    enterEmail("two@example.test");
    await previewEmail(recipient.email);
    await act(async () => {
      latest.resolve({ email: recipient.email, recipient: null });
    });
    await act(async () => {
      old.resolve({ email: recipient.email, recipient });
    });
    expect(
      screen.getByRole("button", { name: "Create invitation link" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: confirmLabel }),
    ).not.toBeInTheDocument();
  });

  it("does not treat a failed preview or a mismatched response email as an unregistered recipient", async () => {
    actions.preview
      .mockResolvedValueOnce({ error: "Recipient unavailable" })
      .mockResolvedValueOnce({ email: "other@example.test", recipient: null });
    render(<WorkspaceInviteForm workspaceSlug="team" canInvite />);
    await previewEmail(recipient.email);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Recipient unavailable",
    );
    expect(
      screen.getByRole("textbox", { name: "Recipient email" }),
    ).toHaveValue(recipient.email);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Preview recipient" }),
      );
    });
    expect(
      screen.queryByRole("button", { name: "Create invitation link" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: confirmLabel }),
    ).not.toBeInTheDocument();
    expect(actions.invite).not.toHaveBeenCalled();
  });
});

describe("Notification publishing and inbox", () => {
  it.each([false, true])(
    "keeps filters and pagination inside the workspace notification tab (unread=%s)",
    async (unreadOnly) => {
      actions.list.mockResolvedValue({
        items: [],
        total: 21,
        page: 1,
        pageSize: 20,
        unreadCount: 21,
      });
      render(
        await NotificationInbox({
          userId: "recipient-1",
          timeZone: "UTC",
          unreadOnly,
          baseHref: "/app/team/notifications",
        }),
      );
      expect(screen.getByRole("link", { name: "All" })).toHaveAttribute(
        "href",
        "/app/team/notifications",
      );
      expect(screen.getByRole("link", { name: "Unread" })).toHaveAttribute(
        "href",
        "/app/team/notifications?unread=1",
      );
      expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
        "href",
        `/app/team/notifications?${unreadOnly ? "unread=1&" : ""}page=2`,
      );
    },
  );

  it("preserves a failed publication draft, then clears it and displays the actual delivered count", async () => {
    actions.publishSite
      .mockResolvedValueOnce({ error: "Recipient is outside this audience" })
      .mockResolvedValueOnce({ ok: true, recipientCount: 3 });
    render(<NotificationPublishForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Release news" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "First line\nSecond line" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Recipient emails" }),
      {
        target: {
          value: "one@example.test,two@example.test,three@example.test",
        },
      },
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Publish notification" }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Recipient is outside this audience",
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Release news",
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "First line\nSecond line",
    );
    expect(
      screen.getByRole("textbox", { name: "Recipient emails" }),
    ).toHaveValue("one@example.test,two@example.test,three@example.test");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Publish notification" }),
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Notification sent to 3 recipients.",
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(
      screen.getByRole("textbox", { name: "Recipient emails" }),
    ).toHaveValue("");
  });

  it("renders announcement markup as text and keeps an unread item visible when marking it fails", async () => {
    const body = "<img src=x onerror=alert(1)>";
    const page: NotificationPage = {
      items: [
        {
          id: "notice-1",
          kind: "site_announcement",
          title: "Untrusted announcement",
          body,
          workspaceName: null,
          createdAt: new Date("2026-10-08T12:00:00Z"),
          readAt: null,
          canAcceptInvitation: false,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      unreadCount: 1,
    };
    actions.list.mockResolvedValue(page);
    actions.markRead.mockResolvedValue({ error: "Could not mark as read" });
    const { container } = render(
      await NotificationInbox({
        userId: "recipient-1",
        timeZone: "UTC",
        unreadOnly: true,
      }),
    );
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not mark as read",
    );
    expect(
      screen.getByRole("heading", { name: "Untrusted announcement" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as read" })).toBeEnabled();
    expect(screen.getByText("1 unread notifications")).toBeInTheDocument();
    expect(actions.refresh).not.toHaveBeenCalled();
  });
});
