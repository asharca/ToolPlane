"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AdminAgentMarketError,
  approvePendingAgentRelease,
  deleteDirectoryAgentListing,
  rejectPendingAgentRelease,
  setDirectoryAgentListingStatus,
} from "@/lib/admin/agent-market";
import { requireAdmin } from "@/lib/auth/admin";
import type { AdminActionState } from "@/lib/admin/user-actions";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

function ids(formData: FormData, key: string): string[] {
  return [...new Set(formData.getAll(key).map(String).filter(Boolean))];
}

function actionErrorKey(
  error: unknown,
):
  | "errorAgentDirectorySlugExists"
  | "errorAgentListingInstalled"
  | "errorAgentReleaseNotPending"
  | "errorAgentReleasePendingBeforeConfig"
  | "errorAgentApprovedReleaseRequired"
  | "errorAgentPublisherWorkspaceMissing"
  | "errorInvalidAgentTemplateConfig"
  | "errorInvalidAgentRelease"
  | "errorMarketCategoryRequired"
  | "errorInvalidMarketCategories"
  | "errorActionFailed" {
  if (!(error instanceof AdminAgentMarketError)) return "errorActionFailed";
  if (error.code === "slug_conflict") return "errorAgentDirectorySlugExists";
  if (error.code === "installed") return "errorAgentListingInstalled";
  if (
    error.code === "release_not_found" ||
    error.code === "release_not_pending"
  ) {
    return "errorAgentReleaseNotPending";
  }
  if (error.code === "pending_release_exists")
    return "errorAgentReleasePendingBeforeConfig";
  if (error.code === "invalid_config") return "errorInvalidAgentTemplateConfig";
  if (error.code === "invalid_release") return "errorInvalidAgentRelease";
  if (error.code === "invalid_categories")
    return "errorInvalidMarketCategories";
  if (error.code === "publish_without_release")
    return "errorAgentApprovedReleaseRequired";
  if (error.code === "orphaned_publisher")
    return "errorAgentPublisherWorkspaceMissing";
  return "errorActionFailed";
}

function revalidateAgentDirectory(id?: string) {
  revalidatePath("/admin/reviews", "layout");
  revalidatePath("/admin");
  revalidatePath("/admin/agents");
  if (id) revalidatePath(`/admin/agents/${id}/edit`);
  revalidatePath("/app/[workspace]/market/agents", "page");
}

export async function approveAgentReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const listingId = str(formData, "listingId");
  const releaseId = str(formData, "releaseId");
  const categoryIds = ids(formData, "categoryIds");
  if (formData.get("reviewConfirmed") !== "yes") {
    return { error: t("errorAgentReviewConfirmationRequired") };
  }
  if (categoryIds.length === 0)
    return { error: t("errorMarketCategoryRequired") };
  try {
    await approvePendingAgentRelease({
      listingId,
      releaseId,
      reviewedById: admin.id,
      reviewNote: nullable(str(formData, "reviewNote").slice(0, 4000)),
      categoryIds,
    });
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(listingId);
  return { ok: true };
}

export async function rejectAgentReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const listingId = str(formData, "listingId");
  const releaseId = str(formData, "releaseId");
  try {
    await rejectPendingAgentRelease({
      listingId,
      releaseId,
      reviewedById: admin.id,
      reviewNote: nullable(str(formData, "reviewNote").slice(0, 4000)),
    });
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(listingId);
  return { ok: true };
}

export async function setAgentListingStatusAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const id = str(formData, "id");
  if (str(formData, "status") !== "disabled") {
    return { error: t("errorActionFailed") };
  }
  try {
    await setDirectoryAgentListingStatus(id, "disabled", admin.id);
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(id);
  return { ok: true };
}

export async function deleteAgentListingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const id = str(formData, "id");
  try {
    await deleteDirectoryAgentListing(id, admin.id);
  } catch (error) {
    const key = actionErrorKey(error);
    if (
      key === "errorAgentListingInstalled" &&
      error instanceof AdminAgentMarketError
    ) {
      return { error: t(key, { count: error.count ?? 0 }) };
    }
    return { error: t(key) };
  }
  revalidateAgentDirectory();
  redirect("/admin/agents");
}
