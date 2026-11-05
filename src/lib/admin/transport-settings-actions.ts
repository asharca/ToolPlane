"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { saveAuditedSetting } from "@/lib/admin/audited-setting";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import { TRANSPORT_SETTINGS_KEY } from "@/lib/admin/transport-settings";
import {
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  MIN_A2A_FILE_BYTES,
  MAX_A2A_FILE_BYTES,
} from "@/lib/transport-policy";

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
      const rawFileMiB = String(formData.get("a2aFileMiB") ?? "").trim();
      const fileMiB = /^\d+$/.test(rawFileMiB) ? Number(rawFileMiB) : NaN;
      if (
        !Number.isSafeInteger(fileMiB) ||
        fileMiB < MIN_A2A_FILE_BYTES / 1024 ** 2 ||
        fileMiB > MAX_A2A_FILE_BYTES / 1024 ** 2
      )
        return {
          error: t("errorA2aFileSize", {
            min: MIN_A2A_FILE_BYTES / 1024 ** 2,
            max: MAX_A2A_FILE_BYTES / 1024 ** 2,
          }),
        };
      await saveAuditedSetting(
        TRANSPORT_SETTINGS_KEY,
        JSON.stringify({
          allowHttp: allowHttp === "true",
          a2aInlineBytes: kib * 1024,
          a2aFileBytes: fileMiB * 1024 ** 2,
        }),
        admin.id,
      );
    }
  } catch {
    return { error: t("errorActionFailed") };
  }
  revalidatePath("/admin/settings");
  return { ok: true };
}
