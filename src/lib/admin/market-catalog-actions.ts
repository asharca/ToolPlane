"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  ADMIN_MARKET_LISTING_STATUSES,
  AdminMarketCatalogError,
  deleteAdminAssistantTemplate,
  updateAdminMarketListing,
  type AdminMarketListingStatus,
} from "@/lib/admin/market-catalog";
import { requireAdmin } from "@/lib/auth/admin";
import type { AdminActionState } from "@/lib/admin/user-actions";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function categoryIds(formData: FormData) {
  return formData.getAll("categoryIds").map(String).filter(Boolean);
}

function errorKey(error: unknown) {
  if (!(error instanceof AdminMarketCatalogError))
    return "errorActionFailed" as const;
  if (error.code === "invalid_categories")
    return "errorInvalidMarketCategories" as const;
  if (error.code === "release_required")
    return "errorMarketApprovedReleaseRequired" as const;
  if (error.code === "invalid_config")
    return "errorInvalidAssistantTemplateConfig" as const;
  if (error.code === "invalid_manifest")
    return "errorInvalidMarketRelease" as const;
  if (error.code === "slug_conflict")
    return "errorAssistantTemplateSlugExists" as const;
  return "errorMarketResourceNotFound" as const;
}

function revalidateMarket() {
  revalidatePath("/admin/reviews", "layout");
  revalidatePath("/admin");
  revalidatePath("/admin/market");
  revalidatePath("/app/[workspace]/market", "layout");
  revalidatePath("/categories");
  revalidatePath("/categories/[slug]", "page");
}

export async function updateMarketListingAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const id = value(formData, "listingId");
  const requestedStatus = value(formData, "status");
  if (
    !id ||
    !ADMIN_MARKET_LISTING_STATUSES.includes(
      requestedStatus as AdminMarketListingStatus,
    )
  ) {
    return { error: t("errorMarketResourceNotFound") };
  }
  try {
    await updateAdminMarketListing(
      {
        id,
        status: requestedStatus as AdminMarketListingStatus,
        curated: formData.get("curated") === "on",
        isFeatured: formData.get("isFeatured") === "on",
        categoryIds: categoryIds(formData),
      },
      admin.id,
    );
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  return { ok: true };
}

export async function deleteAssistantTemplateAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const id = value(formData, "id");
  if (!id) return { error: t("errorMarketResourceNotFound") };
  try {
    await deleteAdminAssistantTemplate(id, admin.id);
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  revalidatePath("/admin/assistants");
  redirect("/admin/assistants");
}
