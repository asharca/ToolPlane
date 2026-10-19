import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  members: vi.fn(),
  invitations: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
  getWorkspaceMembers: m.members,
}));
vi.mock("@/lib/db", () => ({
  db: { workspaceInvitation: { findMany: m.invitations } },
}));
vi.mock("@/lib/workspace/management-actions", () => ({
  createWorkspaceAction: vi.fn(),
  renameWorkspaceAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
  removeWorkspaceMemberAction: vi.fn(),
  leaveWorkspaceAction: vi.fn(),
  revokeWorkspaceInvitationAction: vi.fn(),
  transferWorkspaceOwnershipAction: vi.fn(),
  acceptWorkspaceInvitationAction: vi.fn(),
  setWorkspaceMemberRoleAction: vi.fn(),
  inviteWorkspaceMemberAction: vi.fn(),
  previewWorkspaceInviteRecipientAction: vi.fn(),
}));
vi.mock("@/lib/notifications/actions", () => ({
  publishSiteNotificationAction: vi.fn(),
  publishWorkspaceNotificationAction: vi.fn(),
}));
vi.mock("@/components/dashboard/DashboardHeader", () => ({
  DashboardHeader: () => null,
}));
import Members from "@/app/app/[workspace]/members/page";
const page = () => Members({ params: Promise.resolve({ workspace: "acme" }) });
const member = (userId: string, role: string, name: string | null = null) => ({
  id: `member-${userId}`,
  userId,
  role,
  createdAt: new Date("2026-08-01"),
  user: { name, email: `${userId}@example.com` },
});
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: "owner", timeZone: "UTC" });
  m.workspace.mockResolvedValue({ id: "ws", ownerId: "owner" });
  m.members.mockResolvedValue([
    member("owner", "owner", "Workspace owner"),
    member("admin", "admin", "Workspace admin"),
    member("member", "member"),
  ]);
  m.invitations.mockResolvedValue([]);
});
afterEach(cleanup);
describe("workspace member management permissions", () => {
  it("requires login before accessing membership details", async () => {
    m.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(m.members).not.toHaveBeenCalled();
  });
  it("rejects workspaces unavailable to the viewer", async () => {
    m.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(m.members).not.toHaveBeenCalled();
  });
  it("gives owners role/removal controls for others but never for the owner", async () => {
    await act(async () => {
      render(await page());
    });
    expect(screen.getByText("ownerRole")).toBeInTheDocument();
    expect(screen.getByText("adminRole")).toBeInTheDocument();
    expect(screen.getByText("memberRole")).toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Remove member" }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Leave workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("publishWorkspaceTitle")).toBeInTheDocument();
  });
  it.each(["admin", "member"])(
    "allows %s to leave but not remove or change other members",
    async (id) => {
      m.user.mockResolvedValue({ id, timeZone: "UTC" });
      await act(async () => {
        render(await page());
      });
      expect(
        screen.getByRole("button", { name: "Leave workspace" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Remove member" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("adminCapabilities")).not.toBeInTheDocument();
      expect(m.invitations).not.toHaveBeenCalled();
      expect(screen.queryByText("publishWorkspaceTitle") !== null).toBe(
        id === "admin",
      );
    },
  );
  it("shows pending invitations to owners with expiration and revoke actions", async () => {
    m.invitations.mockResolvedValue([
      {
        id: "expired",
        email: "expired@example.com",
        expiresAt: new Date("2000-01-01"),
      },
      {
        id: "pending",
        email: "pending@example.com",
        expiresAt: new Date("2100-01-01"),
      },
    ]);
    await act(async () => {
      render(await page());
    });
    expect(screen.getByText("pendingInvitations")).toBeInTheDocument();
    const expired = screen.getByText("expired@example.com").closest("li");
    expect(expired).not.toBeNull();
    if (!expired) throw new Error("Missing invitation");
    expect(within(expired).getByText("expired")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Revoke invitation" }),
    ).toHaveLength(2);
  });
});
