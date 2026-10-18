import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInvitation } from "@/components/dashboard/WorkspaceInvitation";
import {
  CreateWorkspaceForm,
  RenameWorkspaceForm,
  WorkspaceDeleteForm,
  WorkspaceMemberAction,
  WorkspaceTransferForm,
  WorkspaceMemberRoleForm,
} from "@/components/dashboard/WorkspaceForms";
import type {
  WorkspaceActionState,
  previewWorkspaceInvitationAction,
} from "@/lib/workspace/management-actions";
import { assertDefined } from "../assert-defined";

const mocks = vi.hoisted(() => ({
  create:
    vi.fn<
      (
        state: WorkspaceActionState,
        form: FormData,
      ) => Promise<WorkspaceActionState>
    >(),
  rename:
    vi.fn<
      (
        state: WorkspaceActionState,
        form: FormData,
      ) => Promise<WorkspaceActionState>
    >(),
  remove:
    vi.fn<
      (
        state: WorkspaceActionState,
        form: FormData,
      ) => Promise<WorkspaceActionState>
    >(),
  preview: vi.fn<typeof previewWorkspaceInvitationAction>(),
  accept:
    vi.fn<
      (
        state: WorkspaceActionState,
        form: FormData,
      ) => Promise<WorkspaceActionState>
    >(),
}));
vi.mock("@/lib/workspace/management-actions", () => ({
  createWorkspaceAction: mocks.create,
  renameWorkspaceAction: mocks.rename,
  deleteWorkspaceAction: mocks.remove,
  removeWorkspaceMemberAction: mocks.remove,
  leaveWorkspaceAction: mocks.remove,
  revokeWorkspaceInvitationAction: mocks.remove,
  transferWorkspaceOwnershipAction: mocks.remove,
  acceptWorkspaceInvitationAction: mocks.accept,
  setWorkspaceMemberRoleAction: mocks.remove,
  previewWorkspaceInvitationAction: mocks.preview,
  switchInvitationAccountAction: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

function submitFrom(element: HTMLElement) {
  fireEvent.submit(assertDefined(element.closest("form")));
}

describe("workspace management workflows", () => {
  it("submits workspace creation intent, locks pending changes, and displays action errors", async () => {
    const { promise, resolve } = Promise.withResolvers<WorkspaceActionState>();
    mocks.create.mockReturnValue(promise);
    render(<CreateWorkspaceForm intent="/app?install=toolkit" autoFocus />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Research" } });
    submitFrom(input);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(input.closest("form")).toHaveAttribute(
      "data-unsaved-changes",
      "true",
    );
    expect(mocks.create.mock.calls[0]?.[1].get("intent")).toBe(
      "/app?install=toolkit",
    );
    expect(mocks.create.mock.calls[0]?.[1].get("name")).toBe("Research");
    await act(async () => resolve({ error: "Workspace limit reached" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace limit reached",
    );
    expect(input).toBeEnabled();
  });

  it("restricts rename to managers, then shows successful action feedback", async () => {
    mocks.rename.mockResolvedValue({ success: "Name saved" });
    const view = render(
      <RenameWorkspaceForm slug="research" name="Research" canManage={false} />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    view.rerender(
      <RenameWorkspaceForm slug="research" name="Research" canManage />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Labs" },
    });
    submitFrom(screen.getByRole("textbox"));
    expect(await screen.findByRole("status")).toHaveTextContent("Name saved");
    expect(mocks.rename.mock.calls[0]?.[1].get("workspace")).toBe("research");
  });

  it.each(["active", "delete_failed"])(
    "requires an exact workspace name for deletion (%s)",
    async (status) => {
      mocks.remove.mockResolvedValue({ error: "Cleanup unavailable" });
      render(
        <WorkspaceDeleteForm
          slug="research"
          name="Research"
          status={status}
          impact="Deletes all sandboxes"
        />,
      );
      if (status === "active")
        fireEvent.click(
          screen.getByRole("button", { name: /^delete workspace$/i }),
        );
      const input = await screen.findByRole("textbox");
      expect(screen.getByText("Deletes all sandboxes")).toBeVisible();
      const button = screen.getByRole("button", {
        name: /permanently delete/i,
      });
      expect(button).toBeDisabled();
      fireEvent.change(input, { target: { value: "research" } });
      expect(button).toBeDisabled();
      fireEvent.change(input, { target: { value: "Research" } });
      expect(button).toBeEnabled();
      submitFrom(input);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Cleanup unavailable",
      );
      expect(mocks.remove.mock.calls[0]?.[1].get("confirmation")).toBe(
        "Research",
      );
    },
  );

  it.each(["remove", "leave", "revoke"] as const)(
    "requires confirmation before %s",
    async (kind) => {
      mocks.remove.mockResolvedValue({ success: "Updated membership" });
      render(
        <WorkspaceMemberAction
          slug="research"
          kind={kind}
          memberId={kind === "remove" ? "member" : undefined}
          invitationId={kind === "revoke" ? "invite" : undefined}
        />,
      );
      fireEvent.click(screen.getByRole("button"));
      const confirm = await screen.findByRole("button", { name: /^confirm$/i });
      fireEvent.click(confirm);
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Updated membership",
      );
      const data = mocks.remove.mock.calls[0]?.[1];
      expect(data?.get("workspace")).toBe("research");
      expect(data?.get("memberId")).toBe(kind === "remove" ? "member" : "");
      expect(data?.get("invitationId")).toBe(kind === "revoke" ? "invite" : "");
    },
  );

  it("submits a member role update with workspace and member identity", async () => {
    mocks.remove.mockResolvedValue({ success: "Role saved" });
    render(
      <WorkspaceMemberRoleForm
        slug="research"
        memberId="member"
        {...{ role: "admin" as const }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("Role saved");
    expect(mocks.remove.mock.calls[0]?.[1].get("role")).toBe("admin");
  });

  it("asks for a new owner and name confirmation before transfer", async () => {
    render(
      <WorkspaceTransferForm
        slug="research"
        name="Research"
        members={[{ userId: "member", label: "New owner" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("textbox")).toBeRequired();
    expect(
      screen.getByRole("button", { name: /confirm ownership transfer/i }),
    ).toBeVisible();
  });
});

describe("invitation recovery and account matching", () => {
  const token = "a".repeat(64);
  it("stores a fragment secret before sign-in and removes it from the address bar", async () => {
    history.replaceState(null, "", `/app?view=invitation#invite=${token}`);
    render(<WorkspaceInvitation signedIn={false} />);
    expect(
      await screen.findByRole("link", { name: /^sign in$/i }),
    ).toHaveAttribute("href", "/app/login?next=%2Fapp%3Fview%3Dinvitation");
    expect(sessionStorage.getItem("toolplane:workspace-invitation")).toBe(
      token,
    );
    expect(location.hash).toBe("");
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("recovers a stored invitation and accepts for the matching signed-in account", async () => {
    sessionStorage.setItem("toolplane:workspace-invitation", token);
    mocks.preview.mockResolvedValue({
      name: "Research",
      email: "member@example.test",
      canJoin: true,
    });
    mocks.accept.mockResolvedValue({ success: "Joined workspace" });
    render(<WorkspaceInvitation signedIn />);
    expect(
      await screen.findByRole("heading", { name: "Research" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /accept and join/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Joined workspace",
    );
    expect(mocks.accept.mock.calls[0]?.[1].get("token")).toBe(token);
  });

  it("offers account switching instead of accepting another recipient's invite", async () => {
    mocks.preview.mockResolvedValue({
      name: "Research",
      email: "other@example.test",
      canJoin: false,
    });
    render(<WorkspaceInvitation signedIn />);
    expect(
      await screen.findByRole("button", {
        name: /sign in with the invited account/i,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /accept and join/i }),
    ).toBeNull();
  });

  it.each([false, true])(
    "reports invalid invitations on missing or rejected preview (reject=%s)",
    async (reject) => {
      if (reject) mocks.preview.mockRejectedValue(new Error("expired"));
      else mocks.preview.mockResolvedValue(null);
      history.replaceState(null, "", "/app#invite=invalid");
      render(<WorkspaceInvitation signedIn />);
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(location.hash).toBe("");
    },
  );
});
