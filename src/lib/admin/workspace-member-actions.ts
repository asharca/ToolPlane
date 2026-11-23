"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actionScope } from "@/lib/workspace/action-scope";
import { logSystemEvent } from "@/lib/observability/system";
import { WorkspaceManagementError } from "@/lib/workspace/management";
import { isWorkspacePermission } from "@/lib/workspace/permissions";
import type { AdminActionState } from "@/lib/admin/user-actions";
import {
  adminAddWorkspaceMember,
  adminRemoveWorkspaceMember,
  adminSetWorkspaceMemberPermission,
  adminSetWorkspaceMemberRole,
  searchJoinableWorkspaces,
} from "@/lib/admin/workspace-members";

const KNOWN_ERRORS: Record<string, true> = {
  workspaceMissing: true,
  unavailable: true,
  userMissing: true,
  inactiveUser: true,
  alreadyMember: true,
  memberMissing: true,
  transferFirst: true,
  ownerLocked: true,
  forbidden: true,
};

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" && value.length <= 128 ? value : "";
}

async function perform(
  form: FormData,
  event: string,
  operation: (
    adminId: string,
    workspaceId: string,
    userId: string,
  ) => Promise<void>,
): Promise<AdminActionState> {
  const admin = await actionScope({ admin: true });
  const t = await getTranslations("adminWorkspaceAccess.errors");
  const workspaceId = field(form, "workspaceId");
  const userId = field(form, "userId");
  if (!workspaceId || !userId) return { error: t("failed") };
  try {
    await operation(admin.id, workspaceId, userId);
  } catch (error) {
    const code =
      error instanceof WorkspaceManagementError &&
      Object.hasOwn(KNOWN_ERRORS, error.message)
        ? error.message
        : null;
    if (!code)
      logSystemEvent(event, {
        error,
        actorId: admin.id,
        workspaceId,
        attributes: { targetUserId: userId },
      });
    return { error: t(code ?? "failed") };
  }
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  return { ok: true };
}

function role(form: FormData): "admin" | "member" | null {
  const value = field(form, "role");
  return value === "admin" || value === "member" ? value : null;
}

export async function addWorkspaceMemberAdminAction(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const next = role(form);
  return perform(form, "admin.workspace_members.add_failed", (a, w, u) =>
    next
      ? adminAddWorkspaceMember(a, w, u, next)
      : Promise.reject(new WorkspaceManagementError("forbidden")),
  );
}

export async function setWorkspaceMemberRoleAdminAction(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const next = role(form);
  return perform(form, "admin.workspace_members.role_failed", (a, w, u) =>
    next
      ? adminSetWorkspaceMemberRole(a, w, u, next)
      : Promise.reject(new WorkspaceManagementError("forbidden")),
  );
}

export async function removeWorkspaceMemberAdminAction(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  return perform(
    form,
    "admin.workspace_members.remove_failed",
    adminRemoveWorkspaceMember,
  );
}

/** `enabled` is "true" or "false": the desired effective state. */
export async function setWorkspaceMemberPermissionAdminAction(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const permission = field(form, "permission");
  const enabled = field(form, "enabled");
  return perform(
    form,
    "admin.workspace_members.permission_failed",
    (a, w, u) =>
      isWorkspacePermission(permission) &&
      (enabled === "true" || enabled === "false")
        ? adminSetWorkspaceMemberPermission(
            a,
            w,
            u,
            permission,
            enabled === "true",
          )
        : Promise.reject(new WorkspaceManagementError("forbidden")),
  );
}

export async function searchJoinableWorkspacesAdminAction(
  userId: string,
  query: string,
): Promise<{ id: string; slug: string; name: string }[]> {
  await actionScope({ admin: true });
  if (typeof userId !== "string" || typeof query !== "string") return [];
  return searchJoinableWorkspaces(userId, query);
}
