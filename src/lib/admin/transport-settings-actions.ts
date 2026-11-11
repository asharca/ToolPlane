"use server";

import { logSystemEvent } from "@/lib/observability/system";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { saveAuditedSetting } from "@/lib/admin/audited-setting";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import { TRANSPORT_SETTINGS_KEY } from "@/lib/admin/transport-settings";
import {
  A2A_FILE_LIMIT_RANGES,
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  type A2AFileLimits,
} from "@/lib/transport-policy";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** Form field, unit and validation message for each administrator file limit. */
const FILE_LIMIT_FIELDS = [
  ["a2aFileBytes", "a2aFileMiB", MiB, "errorA2aFileSize"],
  ["a2aTaskInputBytes", "a2aTaskInputMiB", MiB, "errorA2aTaskInputSize"],
  ["a2aTaskFiles", "a2aTaskFiles", 1, "errorA2aTaskFiles"],
  [
    "a2aWorkspaceFileBytes",
    "a2aWorkspaceFileGiB",
    GiB,
    "errorA2aWorkspaceFileSize",
  ],
] as const;

export async function updateTransportSettingsAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  try {
    if (formData.get("intent") === "reset") {
      await saveAuditedSetting(TRANSPORT_SETTINGS_KEY, null, admin.id);
    } else {
      const allowHttp = formData.get("allowHttp");
      const raw = String(formData.get("a2aInlineKiB") ?? "").trim();
      const kib = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (
        (allowHttp !== "true" && allowHttp !== "false") ||
        !Number.isSafeInteger(kib) ||
        kib < MIN_A2A_INLINE_BYTES / 1024 ||
        kib > MAX_A2A_INLINE_BYTES / 1024
      )
        return {
          error: t("errorTransportSettings", {
            min: MIN_A2A_INLINE_BYTES / 1024,
            max: MAX_A2A_INLINE_BYTES / 1024,
          }),
        };
      const limits = {} as A2AFileLimits;
      for (const [key, field, unit, error] of FILE_LIMIT_FIELDS) {
        const raw = String(formData.get(field) ?? "").trim();
        const value = /^\d+$/.test(raw) ? Number(raw) * unit : NaN;
        const [min, max] = A2A_FILE_LIMIT_RANGES[key];
        if (!Number.isSafeInteger(value) || value < min || value > max)
          return { error: t(error, { min: min / unit, max: max / unit }) };
        limits[key] = value;
      }
      await saveAuditedSetting(
        TRANSPORT_SETTINGS_KEY,
        JSON.stringify({
          allowHttp: allowHttp === "true",
          a2aInlineBytes: kib * 1024,
          ...limits,
        }),
        admin.id,
      );
    }
  } catch (error) {
    logSystemEvent("admin.settings.transport_failed", {
      error,
      actorId: admin.id,
    });
    return { error: t("errorActionFailed") };
  }
  revalidatePath("/admin/settings");
  return { ok: true };
}
