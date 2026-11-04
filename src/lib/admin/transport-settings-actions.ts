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
      await saveAuditedSetting(
        TRANSPORT_SETTINGS_KEY,
        JSON.stringify({
          allowHttp: allowHttp === "true",
          a2aInlineBytes: kib * 1024,
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
