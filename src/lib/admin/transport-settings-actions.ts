"use server";

import { actionScope } from "@/lib/workspace/action-scope";
import { logSystemEvent } from "@/lib/observability/system";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { saveAuditedSetting } from "@/lib/admin/audited-setting";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import { TRANSPORT_SETTINGS_KEY } from "@/lib/admin/transport-settings";
import {
  A2A_FILE_LIMIT_RANGES,
  MIN_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
} from "@/lib/transport-policy";

const [minTaskFiles, maxTaskFiles] = A2A_FILE_LIMIT_RANGES.a2aTaskFiles;

export async function updateTransportSettingsAction(
  _prev: AdminSettingsActionState,
  formData: FormData,
): Promise<AdminSettingsActionState> {
  const admin = await actionScope({ admin: true });
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
      const rawTaskFiles = String(formData.get("a2aTaskFiles") ?? "").trim();
      const a2aTaskFiles = /^\d+$/.test(rawTaskFiles)
        ? Number(rawTaskFiles)
        : NaN;
      if (
        !Number.isSafeInteger(a2aTaskFiles) ||
        a2aTaskFiles < minTaskFiles ||
        a2aTaskFiles > maxTaskFiles
      )
        return {
          error: t("errorA2aTaskFiles", {
            min: minTaskFiles,
            max: maxTaskFiles,
          }),
        };
      await saveAuditedSetting(
        TRANSPORT_SETTINGS_KEY,
        JSON.stringify({
          allowHttp: allowHttp === "true",
          a2aInlineBytes: kib * 1024,
          a2aTaskFiles,
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
