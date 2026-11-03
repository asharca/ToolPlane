"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";

export async function withdrawPluginListing(form: FormData) {
  const admin = await requireAdmin();
  const id = String(form.get("listingId") ?? "");
  await db.$transaction(async (tx) => {
    const result = await tx.marketListing.updateMany({
      where: { id, kind: "pi-package", status: "published" },
      data: { status: "withdrawn" },
    });
    if (result.count !== 1) throw new Error("Published plugin not found.");
    await writeAudit(tx, {
      actorId: admin.id,
      action: "plugin.withdrawn",
      targetType: "marketListing",
      targetId: id,
    });
  });
  revalidatePath("/admin/market");
}

export async function revokePluginRelease(form: FormData) {
  const admin = await requireAdmin();
  const id = String(form.get("releaseId") ?? "");
  await db.$transaction(async (tx) => {
    const result = await tx.marketRelease.updateMany({
      where: { id, listing: { kind: "pi-package" }, reviewStatus: "approved" },
      data: {
        reviewStatus: "revoked",
        reviewedById: admin.id,
        reviewedAt: new Date(),
      },
    });
    if (result.count !== 1)
      throw new Error("Approved plugin release not found.");
    await writeAudit(tx, {
      actorId: admin.id,
      action: "plugin.release.revoked",
      targetType: "marketRelease",
      targetId: id,
    });
  });
  revalidatePath("/admin/market");
}
