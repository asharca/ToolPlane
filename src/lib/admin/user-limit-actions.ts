"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actionScope } from "@/lib/workspace/action-scope";
import { saveAuditedSetting } from "@/lib/admin/audited-setting";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { logSystemEvent } from "@/lib/observability/system";
import { GiB, USER_LIMIT_RANGES } from "@/lib/storage/user-limit-policy";
import { lockUserLimits, USER_LIMITS_KEY } from "@/lib/storage/user-quota";

const minStorage = USER_LIMIT_RANGES.storageQuotaBytes[0] / GiB;
const maxStorage = USER_LIMIT_RANGES.storageQuotaBytes[1] / GiB;
const [minWorkspaces, maxWorkspaces] = USER_LIMIT_RANGES.maxOwnedWorkspaces;

function readLimit(
  form: FormData,
  field: string,
  min: number,
  max: number,
  optional: boolean,
) {
  const entry = form.get(field);
  if (typeof entry !== "string") return undefined;
  const raw = entry.trim();
  if (!raw && optional) return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function readLimits(form: FormData, optional: boolean) {
  const storageGiB = readLimit(
    form,
    "storageQuotaGiB",
    minStorage,
    maxStorage,
    optional,
  );
  if (storageGiB === undefined)
    return {
      invalid: "errorUserStorageQuota",
      min: minStorage,
      max: maxStorage,
    } as const;
  const maxOwnedWorkspaces = readLimit(
    form,
    "maxOwnedWorkspaces",
    minWorkspaces,
    maxWorkspaces,
    optional,
  );
  if (maxOwnedWorkspaces === undefined)
    return {
      invalid: "errorUserWorkspaceLimit",
      min: minWorkspaces,
      max: maxWorkspaces,
    } as const;
  return {
    limits: {
      storageQuotaBytes: storageGiB === null ? null : storageGiB * GiB,
      maxOwnedWorkspaces,
    },
  };
}

export async function updateUserLimitDefaultsAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  const admin = await actionScope({ admin: true });
  const t = await getTranslations("admin");
  try {
    if (formData.get("intent") === "reset") {
      await saveAuditedSetting(USER_LIMITS_KEY, null, admin.id);
    } else {
      const result = readLimits(formData, false);
      if (result.invalid)
        return {
          error: t(result.invalid, { min: result.min, max: result.max }),
        };
      await saveAuditedSetting(
        USER_LIMITS_KEY,
        JSON.stringify(result.limits),
        admin.id,
      );
    }
  } catch (error) {
    logSystemEvent("admin.settings.user_limits_failed", {
      error,
      actorId: admin.id,
    });
    return { error: t("errorActionFailed") };
  }
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function updateUserLimitOverridesAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  const admin = await actionScope({ admin: true });
  const t = await getTranslations("admin");
  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId)
    return { error: t("errorActionFailed") };
  const result = readLimits(formData, true);
  if (result.invalid)
    return { error: t(result.invalid, { min: result.min, max: result.max }) };
  const { limits } = result;
  try {
    await db.$transaction(async (tx) => {
      const [before] = await lockUserLimits(tx, userId);
      if (!before) throw new Error("User not found.");
      await tx.user.update({
        where: { id: userId },
        data: {
          storageQuotaBytes:
            limits.storageQuotaBytes === null
              ? null
              : BigInt(limits.storageQuotaBytes),
          maxOwnedWorkspaces: limits.maxOwnedWorkspaces,
        },
      });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "user.limits_changed",
        targetType: "user",
        targetId: userId,
        changes: {
          before: {
            storageQuotaBytes:
              before.storageQuotaBytes === null
                ? null
                : Number(before.storageQuotaBytes),
            maxOwnedWorkspaces: before.maxOwnedWorkspaces,
          },
          after: limits,
        },
      });
    });
  } catch (error) {
    logSystemEvent("admin.users.limits_failed", {
      error,
      actorId: admin.id,
      attributes: { targetUserId: userId },
    });
    return { error: t("errorActionFailed") };
  }
  revalidatePath(`/admin/users/${userId}`);
  return { ok: true };
}
