"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { safeRelativePath } from "@/lib/auth/safe-redirect";
import { clearSession } from "@/lib/auth/session";
import { WORKSPACE_MANAGER_HREF } from "./navigation";
import {
  WorkspaceManagementError,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  inviteWorkspaceMember,
  acceptWorkspaceInvitation,
  revokeWorkspaceInvitation,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  transferWorkspaceOwnership,
  getWorkspaceInvitation,
  previewWorkspaceInviteRecipient,
  acceptWorkspaceInvitationNotification,
} from "./management";

export type WorkspaceActionState = {
  error?: string;
  success?: string;
  invitePath?: string;
};
export type WorkspaceInvitePreviewState = {
  error?: string;
  email?: string;
  recipient?: { id: string; name: string | null; email: string } | null;
};

function text(form: FormData, key: string, max = 128): string {
  const value = form.get(key);
  return typeof value === "string" && value.length <= max ? value : "";
}

async function perform(
  form: FormData,
  operation: (
    actorId: string,
    slug: string,
  ) => Promise<{ redirectTo?: string; invitePath?: string }> | Promise<void>,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const t = await getTranslations("console.workspaces");
  let result: { redirectTo?: string; invitePath?: string } | undefined;
  try {
    result = (await operation(user.id, text(form, "workspace"))) || undefined;
  } catch (error) {
    revalidatePath("/app", "layout");
    return {
      error: t(
        `errors.${error instanceof WorkspaceManagementError ? error.message : "failed"}`,
      ),
    };
  }
  revalidatePath("/app", "layout");
  if (result?.redirectTo) redirect(result.redirectTo);
  return {
    success: t("saved"),
    ...(result?.invitePath ? { invitePath: result.invitePath } : {}),
  };
}

export async function createWorkspaceAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId) => {
    const workspace = await createWorkspace(actorId, text(form, "name", 80));
    const intent = safeRelativePath(text(form, "intent", 1024));
    return {
      redirectTo: intent?.startsWith("/app?")
        ? `${intent}&workspace=${encodeURIComponent(workspace.slug)}`
        : `/app/${workspace.slug}/work?welcome=1`,
    };
  });
}

export async function renameWorkspaceAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, (actorId, slug) =>
    renameWorkspace(actorId, slug, text(form, "name", 80)),
  );
}

export async function inviteWorkspaceMemberAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId, slug) => {
    const recipientId = form.get("recipientId");
    if (typeof recipientId !== "string" || recipientId.length > 200)
      throw new WorkspaceManagementError("recipientChanged");
    return {
      invitePath: await inviteWorkspaceMember(actorId, slug, {
        email: text(form, "email", 320),
        recipientId: recipientId || null,
      }),
    };
  });
}

export async function previewWorkspaceInviteRecipientAction(
  _prev: WorkspaceInvitePreviewState,
  form: FormData,
): Promise<WorkspaceInvitePreviewState> {
  const user = await getCurrentUser();
  const t = await getTranslations("console.workspaces");
  if (!user) return { error: t("errors.forbidden") };
  try {
    const email = text(form, "email", 320).trim().toLowerCase();
    const recipient = await previewWorkspaceInviteRecipient(
      user.id,
      text(form, "workspace"),
      email,
    );
    return { email, recipient };
  } catch (error) {
    return {
      error: t(
        `errors.${error instanceof WorkspaceManagementError ? error.message : "failed"}`,
      ),
    };
  }
}

export async function acceptWorkspaceInvitationAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId) => ({
    redirectTo: `/app/${await acceptWorkspaceInvitation(actorId, text(form, "token"))}/work?welcome=1`,
  }));
}

export async function acceptWorkspaceInvitationNotificationAction(
  _prev: WorkspaceActionState,
  form: FormData,
): Promise<WorkspaceActionState> {
  return perform(form, async (actorId) => ({
    redirectTo: `/app/${await acceptWorkspaceInvitationNotification(actorId, text(form, "notificationId", 200))}/work?welcome=1`,
  }));
}

export async function switchInvitationAccountAction(form: FormData) {
  void form;
  await clearSession();
  redirect(`/app/login?next=${encodeURIComponent("/app?view=invitation")}`);
}

export async function previewWorkspaceInvitationAction(token: string) {
  const user = await getCurrentUser();
  if (!user || typeof token !== "string" || token.length !== 64) return null;
  const invitation = await getWorkspaceInvitation(token);
  return invitation
    ? {
        name: invitation.workspace.name,
        email: invitation.email,
        canJoin:
          invitation.email === user.email.toLowerCase() &&
          (invitation.notification === null ||
            invitation.notification.recipients.some(
              (receipt) => receipt.userId === user.id,
            )),
      }
    : null;
}

export async function revokeWorkspaceInvitationAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, (actorId, slug) =>
    revokeWorkspaceInvitation(actorId, slug, text(form, "invitationId")),
  );
}

export async function removeWorkspaceMemberAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId, slug) => {
    await removeWorkspaceMember(actorId, slug, text(form, "memberId"));
  });
}

export async function setWorkspaceMemberRoleAction(
  _prev: WorkspaceActionState,
  form: FormData,
): Promise<WorkspaceActionState> {
  return perform(form, (actorId, slug) => {
    const role = text(form, "role");
    if (role !== "admin" && role !== "member")
      throw new WorkspaceManagementError("forbidden");
    return setWorkspaceMemberRole(actorId, slug, text(form, "memberId"), role);
  });
}

export async function leaveWorkspaceAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId, slug) => {
    await removeWorkspaceMember(actorId, slug, actorId);
    return { redirectTo: `${WORKSPACE_MANAGER_HREF}&notice=left` };
  });
}

export async function transferWorkspaceOwnershipAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, (actorId, slug) =>
    transferWorkspaceOwnership(
      actorId,
      slug,
      text(form, "memberId"),
      text(form, "confirmation", 80),
    ),
  );
}

export async function deleteWorkspaceAction(
  _prev: WorkspaceActionState,
  form: FormData,
) {
  return perform(form, async (actorId, slug) => {
    await deleteWorkspace(actorId, slug, text(form, "confirmation", 80));
    return { redirectTo: `${WORKSPACE_MANAGER_HREF}&notice=deleted` };
  });
}
