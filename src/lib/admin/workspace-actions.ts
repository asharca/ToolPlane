"use server";

import { logSystemEvent } from "@/lib/observability/system";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { deleteManagedWorkspace } from "@/lib/admin/workspaces";
import type { AdminActionState } from "@/lib/admin/user-actions";
import { db } from "@/lib/db";

export async function deleteWorkspaceAdminAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace || confirm !== workspace.slug)
    return { error: t("errorTypeSlug") };
  try {
    await deleteManagedWorkspace(workspaceId, admin.id);
  } catch (error) {
    logSystemEvent("admin.workspaces.delete_failed", {
      error,
      actorId: admin.id,
      workspaceId,
    });
    return { error: t("errorActionFailed") };
  }
  revalidatePath("/admin/workspaces");
  redirect("/admin/workspaces");
}
