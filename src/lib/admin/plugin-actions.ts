"use server";

import { actionScope } from "@/lib/workspace/action-scope";
import { logSystemEvent } from "@/lib/observability/system";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import {
  adminPluginPresetUpdateSchema,
  clearOfficialPluginEnvPreset,
  saveOfficialPluginEnvPreset,
} from "@/lib/plugins/env-store";
import { PluginError } from "@/lib/plugins/errors";
import { z } from "zod";

export type AdminPluginPresetActionState = {
  error?: string;
  success?: boolean;
};

export async function withdrawPluginListing(form: FormData) {
  const admin = await actionScope({ admin: true });
  const id = String(form.get("listingId") ?? "");
  await db
    .$transaction(async (tx) => {
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
    })
    .catch((error) => {
      if (
        !(
          error instanceof Error &&
          error.message === "Published plugin not found."
        )
      ) {
        logSystemEvent("admin.plugins.withdraw_failed", {
          error,
          actorId: admin.id,
          attributes: { listingId: id },
        });
      }
      throw error;
    });
  revalidatePath("/admin/market");
}

export async function revokePluginRelease(form: FormData) {
  const admin = await actionScope({ admin: true });
  const id = String(form.get("releaseId") ?? "");
  await db
    .$transaction(async (tx) => {
      const result = await tx.marketRelease.updateMany({
        where: {
          id,
          listing: { kind: "pi-package" },
          reviewStatus: "approved",
        },
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
    })
    .catch((error) => {
      if (
        !(
          error instanceof Error &&
          error.message === "Approved plugin release not found."
        )
      ) {
        logSystemEvent("admin.plugins.revoke_failed", {
          error,
          actorId: admin.id,
          attributes: { releaseId: id },
        });
      }
      throw error;
    });
  revalidatePath("/admin/market");
}

export async function saveOfficialPluginEnvPresetAction(
  _previous: AdminPluginPresetActionState,
  form: FormData,
): Promise<AdminPluginPresetActionState> {
  const admin = await actionScope({ admin: true });
  const listingId = String(form.get("listingId") ?? "");
  try {
    const rawValues = String(form.get("values") ?? "{}");
    const rawClearKeys = String(form.get("clearKeys") ?? "[]");
    const parsed = adminPluginPresetUpdateSchema.parse({
      values: JSON.parse(rawValues),
      clearKeys: JSON.parse(rawClearKeys),
    });
    await saveOfficialPluginEnvPreset(admin.id, listingId, parsed);
    revalidatePath("/admin/market");
    return { success: true };
  } catch (error) {
    if (error instanceof PluginError) return { error: error.code };
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return { error: "invalid_input" };
    logSystemEvent("admin.plugins.preset_save_failed", {
      error,
      actorId: admin.id,
      attributes: { listingId },
    });
    return { error: "operation_failed" };
  }
}

export async function clearOfficialPluginEnvPresetAction(
  _previous: AdminPluginPresetActionState,
  form: FormData,
): Promise<AdminPluginPresetActionState> {
  const admin = await actionScope({ admin: true });
  const listingId = String(form.get("listingId") ?? "");
  try {
    await clearOfficialPluginEnvPreset(admin.id, listingId);
    revalidatePath("/admin/market");
    return { success: true };
  } catch (error) {
    if (error instanceof PluginError) return { error: error.code };
    logSystemEvent("admin.plugins.preset_clear_failed", {
      error,
      actorId: admin.id,
      attributes: { listingId },
    });
    return { error: "operation_failed" };
  }
}
